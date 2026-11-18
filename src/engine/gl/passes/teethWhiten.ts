/**
 * Teeth whitening (美牙) inside the feathered mouth-opening mask. Only
 * teeth-like pixels (bright, low chroma, not red) are changed: their yellow
 * cast is removed and they are brightened a little. Lips, gums, tongue and
 * the dark mouth interior fail the colour test and stay untouched.
 */
import { faceMask } from '../../../face/mask';
import { GLSL_COLOR, GLSL_HEADER } from '../glsl';
import type { Pass } from '../pass';

const SHADER = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D u_image;
uniform sampler2D u_mask;
uniform float u_amount;

float teethLikelihood(vec3 ycc) {
  float yellow = 0.5 - ycc.y;
  float red = ycc.z - 0.5;
  float bright = smoothstep(0.26, 0.46, ycc.x);
  float notRed = 1.0 - smoothstep(0.045, 0.085, red);
  float notTooYellow = 1.0 - smoothstep(0.13, 0.2, yellow);
  return bright * notRed * notTooYellow;
}

void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 ycc = rgbToYCbCr(src.rgb);
  float k = u_amount * texture(u_mask, v_uv).r * teethLikelihood(ycc);
  // Remove most of the yellow (low Cb) and some warmth (high Cr).
  ycc.y = mix(ycc.y, max(ycc.y, 0.5), 0.8 * k);
  ycc.z = mix(ycc.z, 0.5, 0.35 * k);
  // Gentle midtone lift; zero at black and white.
  ycc.x += 0.35 * k * ycc.x * (1.0 - ycc.x);
  outColor = vec4(clamp(yCbCrToRgb(ycc), 0.0, 1.0), src.a);
}
`;

export const teethWhitenPass: Pass<'teethWhiten'> = {
  kind: 'teethWhiten',
  run(env, input, output, layer) {
    const { gpu } = env;
    const mask = faceMask(env, 'teeth');
    const amount = Math.min(1, Math.max(0, layer.params.amount));
    if (!mask || amount <= 0) {
      gpu.copy(input, output);
      return;
    }
    gpu.draw(gpu.program('teethWhiten', SHADER), output, { u_image: input, u_mask: mask, u_amount: amount });
  },
};
