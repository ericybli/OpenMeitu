import { gaussianBlur } from '../blur';
import { GLSL_COLOR, GLSL_HEADER } from '../glsl';
import type { Pass } from '../pass';

/** Blur sigma range in source pixels, selected by `radius`. */
const SIGMA_MIN = 0.6;
const SIGMA_MAX = 3;
/** Floor in working pixels so the reduced-resolution preview still shows the effect. */
const MIN_WORKING_SIGMA = 0.5;
/** Unsharp-mask gain at amount = 1. */
const MAX_STRENGTH = 1.8;
/** Largest luminance change (sRGB units) an edge can receive; limits halos. */
const HALO_LIMIT = 0.12;

const FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D u_image;
uniform sampler2D u_blurred;
uniform float u_strength;
uniform float u_haloLimit;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); // exact texel reads, like the adjust pass
  vec4 c = texelFetch(u_image, p, 0);
  float detail = luma(c.rgb) - luma(texelFetch(u_blurred, p, 0).rgb);
  // Soft-limit the boost: fine detail gets the full gain, strong edges saturate.
  float boost = u_haloLimit * tanh(u_strength * detail / u_haloLimit);
  // The same offset on every channel sharpens luminance only (no colour fringes).
  outColor = vec4(clamp(c.rgb + boost, 0.0, 1.0), c.a);
}
`;

/** Luminance unsharp mask with a resolution-independent radius. */
export const sharpenPass: Pass<'sharpen'> = {
  kind: 'sharpen',
  run(env, input, output, layer) {
    const { amount, radius } = layer.params;
    const sigmaSource = SIGMA_MIN + (SIGMA_MAX - SIGMA_MIN) * Math.min(1, Math.max(0, radius));
    const sigma = Math.max(MIN_WORKING_SIGMA, sigmaSource * env.scale);
    const blurred = env.gpu.acquire(input.width, input.height);
    try {
      gaussianBlur(env.gpu, input, blurred, sigma);
      env.gpu.draw(env.gpu.program('pass.sharpen', FRAGMENT), output, {
        u_image: input,
        u_blurred: blurred,
        u_strength: MAX_STRENGTH * Math.min(1, Math.max(0, amount)),
        u_haloLimit: HALO_LIMIT,
      });
    } finally {
      env.gpu.release(blurred);
    }
  },
};
