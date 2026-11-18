import { GLSL_HEADER } from './glsl';
import type { Gpu, GpuTexture, RenderTarget } from './gpu';

/** Max taps per side in the 1D kernel; larger blurs are done at reduced resolution. */
const MAX_RADIUS = 48;
/** Above this sigma (pixels) we blur a copy reduced by successive halving, then upsample. */
const DOWNSAMPLE_SIGMA = 4;
/** Halving stops before the blur left to do on the reduced copy drops below this sigma (reduced pixels). */
const MIN_REDUCED_SIGMA = DOWNSAMPLE_SIGMA / 2;
const MAX_REDUCTION = 16;

// Taps are exact texel reads (clamped to the edge), so a pixel's result does not
// depend on the image size: the same pixels blur the same in a crop and in the whole.
const GAUSS_1D = `${GLSL_HEADER}
uniform sampler2D u_image;
uniform ivec2 u_axis;                       // blur direction: (1, 0) or (0, 1)
uniform int u_radius;                       // taps per side
uniform float u_weights[${MAX_RADIUS + 1}];  // normalised Gaussian weights by tap distance
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(u_image, 0) - 1;
  vec4 sum = u_weights[0] * texelFetch(u_image, p, 0);
  for (int i = 1; i <= ${MAX_RADIUS}; i++) {
    if (i > u_radius) break;
    ivec2 offset = u_axis * i;
    sum += u_weights[i] * (texelFetch(u_image, clamp(p + offset, ivec2(0), last), 0) + texelFetch(u_image, clamp(p - offset, ivec2(0), last), 0));
  }
  outColor = sum;
}
`;

/** Gaussian weights for tap distances 0..radius, normalised so the whole symmetric kernel sums to 1. */
function kernelWeights(sigma: number, radius: number): Float32Array {
  const weights = new Float32Array(MAX_RADIUS + 1);
  let total = 0;
  for (let i = 0; i <= radius; i++) {
    weights[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    total += i === 0 ? weights[i] : 2 * weights[i];
  }
  for (let i = 0; i <= radius; i++) weights[i] /= total;
  return weights;
}

/** `output` must be the size of `input`. */
function blurSeparable(gpu: Gpu, input: GpuTexture, output: RenderTarget, sigma: number): void {
  const program = gpu.program('blur.gauss1d', GAUSS_1D);
  const radius = Math.min(MAX_RADIUS, Math.max(1, Math.ceil(sigma * 3)));
  const u_weights = kernelWeights(sigma, radius);
  const tmp = gpu.acquire(output.width, output.height);
  gpu.draw(program, tmp, { u_image: input, u_axis: [1, 0], u_radius: radius, u_weights });
  gpu.draw(program, output, { u_image: tmp, u_axis: [0, 1], u_radius: radius, u_weights });
  gpu.release(tmp);
}

/**
 * Gaussian blur `input` into `output` (same size expected) with standard
 * deviation `sigmaPx` in pixels of `input`. Wider sigmas are computed on a
 * reduced copy, which is visually indistinguishable for wide blurs.
 * `output` must not be `input`.
 */
export function gaussianBlur(gpu: Gpu, input: GpuTexture, output: RenderTarget, sigmaPx: number): void {
  if (!(sigmaPx > 0.3)) {
    gpu.copy(input, output);
    return;
  }
  if (sigmaPx <= DOWNSAMPLE_SIGMA) {
    blurSeparable(gpu, input, output, sigmaPx);
    return;
  }
  // Downsample by successive halving (2x2 box averages) to avoid aliasing.
  const temps: RenderTarget[] = [];
  let cur: GpuTexture = input;
  let factor = 1;
  while (factor < MAX_REDUCTION && sigmaPx / (factor * 2) >= MIN_REDUCED_SIGMA && cur.width > 2 && cur.height > 2) {
    const t = gpu.acquire(Math.max(1, Math.ceil(cur.width / 2)), Math.max(1, Math.ceil(cur.height / 2)));
    gpu.copy(cur, t);
    temps.push(t);
    cur = t;
    factor *= 2;
  }
  if (factor === 1) {
    blurSeparable(gpu, input, output, sigmaPx);
    return;
  }
  // The box reduction (variance (f^2 - 1) / 12) and the bilinear upsample (about f^2 / 6) blur too.
  const addedVariance = (3 * factor * factor - 1) / 12;
  const reducedSigma = Math.sqrt(Math.max(0, sigmaPx * sigmaPx - addedVariance)) * (cur.width / input.width);
  const small = gpu.acquire(cur.width, cur.height);
  blurSeparable(gpu, cur, small, reducedSigma);
  gpu.copy(small, output); // bilinear upsample
  gpu.release(small);
  for (const t of temps) gpu.release(t);
}
