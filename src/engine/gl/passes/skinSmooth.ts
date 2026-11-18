/**
 * Skin smoothing (磨皮): an edge-preserving guided filter (He, Sun & Tang,
 * "Guided Image Filtering", 2010/2013) restricted to skin, with fine texture
 * added back so skin keeps its pores instead of turning plastic.
 *
 * The filter uses the image as its own guide with one edge-aware coefficient
 * per window, driven by the mean RGB variance (so luminance and colour edges
 * are both kept):
 *   a = var / (var + eps),  b = (1 - a) * mean,  q = mean(a) * I + mean(b)
 * Following the "fast guided filter" (He & Sun, 2015), window statistics are
 * computed in float inside one shader on a downsampled copy, the (b, a)
 * coefficients are stored in an RGBA8 target (they are bounded to 0..1, so
 * 8 bits suffice, unlike raw second moments) and are smoothed and upsampled
 * before being applied to the full-resolution image.
 *
 * Window and texture sizes follow the face size. When a photo holds faces of
 * clearly different sizes, the filter runs at several scales and each pixel
 * blends the results by the scale level stored in the skin mask.
 */
import { faceMask, SKIN_LIKELIHOOD_GLSL, SKIN_SCALE_LEVELS, skinScale } from '../../../face/mask';
import { gaussianBlur } from '../blur';
import { GLSL_COLOR, GLSL_HEADER } from '../glsl';
import type { Gpu, GpuTexture, RenderTarget } from '../gpu';
import type { Pass, PassEnv } from '../pass';

/** Filter window radius as a fraction of the face width. */
const WINDOW_RADIUS = 0.034;
/** Fine-texture scale kept by `detail`, as a fraction of the face width. */
const FINE_SIGMA = 0.01;
/** Statistics are gathered on a copy downsampled until the window is at most this many pixels. */
const MAX_LOWRES_RADIUS = 6;
/** Taps per side of the statistics window (a (2N+1)^2 grid). */
const STATS_TAPS = 4;
/** Edge threshold (variance) at amount 0 and 1. */
const EPS_MIN = 0.0012;
const EPS_MAX = 0.006;
/** Blend at amount 1; a little of the original keeps the result photographic. */
const MAX_STRENGTH = 0.9;
/** Without a face, only the colour model guides the effect, so it is applied more gently. */
const NO_FACE_STRENGTH = 0.6;

const STATS_SHADER = `${GLSL_HEADER}
uniform sampler2D u_image;
uniform vec2 u_tapStep;  // uv distance between taps
uniform float u_eps;
const int N = ${STATS_TAPS};
void main() {
  vec3 sum = vec3(0.0);
  vec3 sumSq = vec3(0.0);
  float wsum = 0.0;
  // Gaussian window weights with sigma = 0.6 N taps.
  float inv2s2 = 1.0 / (2.0 * float(N * N) * 0.36);
  for (int j = -N; j <= N; j++) {
    for (int i = -N; i <= N; i++) {
      vec2 o = vec2(float(i), float(j));
      float w = exp(-dot(o, o) * inv2s2);
      vec3 c = texture(u_image, v_uv + o * u_tapStep).rgb;
      sum += w * c;
      sumSq += w * c * c;
      wsum += w;
    }
  }
  vec3 mean = sum / wsum;
  vec3 variance = max(sumSq / wsum - mean * mean, vec3(0.0));
  float v = (variance.r + variance.g + variance.b) / 3.0;
  float a = v / (v + u_eps);
  outColor = vec4((1.0 - a) * mean, a);
}
`;

function compositeShader(levels: number, withMask: boolean): string {
  const ks = Array.from({ length: levels }, (_, k) => k);
  return `${GLSL_HEADER}
${GLSL_COLOR}
${SKIN_LIKELIHOOD_GLSL}
uniform sampler2D u_image;
${ks.map((k) => `uniform sampler2D u_coeffs${k};  // smoothed (b.rgb, a) at scale ${k}\nuniform sampler2D u_fine${k};    // input blurred at the fine-texture scale ${k}`).join('\n')}
${withMask ? 'uniform sampler2D u_mask;' : ''}
uniform float u_strength;
uniform float u_detail;
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 I = src.rgb;
  ${withMask ? 'vec4 mask = texture(u_mask, v_uv);' : ''}
  float level = ${withMask ? `min(mask.b * ${(SKIN_SCALE_LEVELS - 1).toFixed(1)}, ${(levels - 1).toFixed(1)})` : '0.0'};
  vec3 smoothed = vec3(0.0);
  vec3 result = vec3(0.0);
  // Blend the filter outputs of neighbouring scales (tent weights sum to 1).
  // The filter already keeps a fraction a of all detail; restore 'detail' of
  // the remaining fine texture (pores) so skin does not look plastic.
${ks
  .map(
    (k) => `  {
    float w = max(0.0, 1.0 - abs(level - ${k.toFixed(1)}));
    vec4 ab = texture(u_coeffs${k}, v_uv);
    vec3 q = ab.a * I + ab.rgb;
    smoothed += w * q;
    result += w * (q + (1.0 - ab.a) * u_detail * (I - texture(u_fine${k}, v_uv).rgb));
  }`,
  )
  .join('\n')}
  float p = skinColorLikelihood(smoothed);
  ${withMask ? 'p *= mask.r;  // retouch mask' : ''}
  outColor = vec4(mix(I, clamp(result, 0.0, 1.0), p * u_strength), src.a);
}
`;
}

/** Successive 2x box downsamples of an image, created on demand. */
class Pyramid {
  private readonly levels: GpuTexture[];
  private readonly owned: RenderTarget[] = [];

  constructor(
    private readonly gpu: Gpu,
    base: GpuTexture,
  ) {
    this.levels = [base];
  }

  /** The image halved `n` times (or fewer, once it gets too small to halve). */
  get(n: number): GpuTexture {
    while (this.levels.length <= n) {
      const top = this.levels[this.levels.length - 1]!;
      if (top.width < 32 || top.height < 32) return top;
      const half = this.gpu.acquire(Math.ceil(top.width / 2), Math.ceil(top.height / 2));
      this.gpu.copy(top, half);
      this.owned.push(half);
      this.levels.push(half);
    }
    return this.levels[n]!;
  }

  release(): void {
    for (const t of this.owned) this.gpu.release(t);
  }
}

/** Smoothed guided-filter coefficients (b.rgb, a) for a window of `radiusPx` pixels of the pyramid base. */
function guidedCoefficients(gpu: Gpu, pyramid: Pyramid, base: GpuTexture, radiusPx: number, eps: number): RenderTarget {
  let halvings = 0;
  while (radiusPx / 2 ** halvings > MAX_LOWRES_RADIUS) halvings++;
  const low = pyramid.get(halvings);
  const radius = Math.max(1, radiusPx * (low.width / base.width));
  const stats = gpu.acquire(low.width, low.height);
  gpu.draw(gpu.program('skinSmooth.stats', STATS_SHADER), stats, {
    u_image: low,
    u_tapStep: [radius / STATS_TAPS / low.width, radius / STATS_TAPS / low.height],
    u_eps: eps,
  });
  const coeffs = gpu.acquire(low.width, low.height);
  gaussianBlur(gpu, stats, coeffs, radius * 0.6);
  gpu.release(stats);
  return coeffs;
}

interface Memo {
  input: GpuTexture | null;
  key: string;
  targets: RenderTarget[];
}

/**
 * Pooled targets computed from `input` for `key`, kept in the pass cache
 * under `slot` so that a parameter they do not depend on, such as `detail`,
 * only costs the composite. They are recomputed, and the old ones returned
 * to the pool, when the key or the input texture changes. Being the first
 * stage, this pass gets the renderer's working source, whose content only
 * changes along with a cache clear, so the texture identifies the input.
 */
function memoTargets(env: PassEnv, slot: string, input: GpuTexture, key: string, compute: () => RenderTarget[]): RenderTarget[] {
  const { gpu } = env;
  const memo = env.cache.get<Memo>(
    slot,
    () => ({ input: null, key: '', targets: [] }),
    (m) => m.targets.forEach((t) => gpu.release(t)),
  );
  if (memo.input !== input || memo.key !== key) {
    for (const t of memo.targets) gpu.release(t);
    // Forget the old result first: if `compute` throws, nothing released or stale is reused.
    Object.assign(memo, { input: null, key: '', targets: [] });
    memo.targets = compute();
    memo.input = input;
    memo.key = key;
  }
  return memo.targets;
}

export const skinSmoothPass: Pass<'skinSmooth'> = {
  kind: 'skinSmooth',
  run(env, input, output, layer) {
    const { gpu } = env;
    const amount = Math.min(1, Math.max(0, layer.params.amount));
    const detail = Math.min(1, Math.max(0, layer.params.detail));
    const mask = faceMask(env, 'skin');
    const scale = skinScale(env);
    const levels = mask ? scale.levels : 1;
    const eps = EPS_MIN + (EPS_MAX - EPS_MIN) * amount;
    const facePx = (k: number) => scale.px / 2 ** k;

    const fine = memoTargets(env, 'skinSmooth.fine', input, `${levels}:${scale.px}`, () =>
      Array.from({ length: levels }, (_, k) => {
        const blurred = gpu.acquire(input.width, input.height);
        gaussianBlur(gpu, input, blurred, facePx(k) * FINE_SIGMA);
        return blurred;
      }),
    );
    const coeffs = memoTargets(env, 'skinSmooth.coeffs', input, `${levels}:${scale.px}:${eps}`, () => {
      const pyramid = new Pyramid(gpu, input);
      try {
        return Array.from({ length: levels }, (_, k) => guidedCoefficients(gpu, pyramid, input, facePx(k) * WINDOW_RADIUS, eps));
      } finally {
        pyramid.release();
      }
    });

    const uniforms: Record<string, GpuTexture | number> = {
      u_image: input,
      u_strength: amount * MAX_STRENGTH * (mask ? 1 : NO_FACE_STRENGTH),
      u_detail: detail,
    };
    if (mask) uniforms.u_mask = mask;
    for (let k = 0; k < levels; k++) {
      uniforms[`u_coeffs${k}`] = coeffs[k]!;
      uniforms[`u_fine${k}`] = fine[k]!;
    }
    const program = gpu.program(`skinSmooth.composite.${levels}${mask ? '.mask' : ''}`, compositeShader(levels, Boolean(mask)));
    gpu.draw(program, output, uniforms);
  },
};
