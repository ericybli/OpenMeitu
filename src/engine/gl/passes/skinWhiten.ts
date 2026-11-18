/**
 * Skin brightening (美白) on the skin mask (or skin colour alone without a
 * face): a soft exposure lift in linear light that rolls off towards white,
 * so midtones brighten, highlights never clip and the ratio between lit and
 * shaded skin (the face's modelling) is largely preserved; plus a slight
 * reduction of yellow and red casts.
 */
import { faceMask, SKIN_LIKELIHOOD_GLSL } from '../../../face/mask';
import { GLSL_COLOR, GLSL_HEADER } from '../glsl';
import type { Pass } from '../pass';

/** Linear-light gain at amount 1 (before roll-off), about +0.7 EV. */
const MAX_GAIN = 1.6;
/** Fraction of the yellow (-Cb) and red (+Cr) chroma removed at amount 1. */
const YELLOW_REDUCTION = 0.15;
const RED_REDUCTION = 0.05;
const NO_FACE_STRENGTH = 0.6;

const SHADER = (withMask: boolean) => `${GLSL_HEADER}
${GLSL_COLOR}
${SKIN_LIKELIHOOD_GLSL}
uniform sampler2D u_image;
${withMask ? 'uniform sampler2D u_mask;' : ''}
uniform float u_strength;
void main() {
  vec4 src = texture(u_image, v_uv);
  float k = skinColorLikelihood(src.rgb) * u_strength;
  ${withMask ? 'k *= texture(u_mask, v_uv).g;  // tone mask' : ''}
  // x * g / (1 + x * (g - 1)): slope g at black, 1 -> 1, monotone, never clips.
  float g = 1.0 + ${(MAX_GAIN - 1).toFixed(4)} * k;
  vec3 lin = srgbToLinear(src.rgb);
  lin = lin * g / (1.0 + lin * (g - 1.0));
  vec3 ycc = rgbToYCbCr(linearToSrgb(lin));
  ycc.y = mix(ycc.y, 0.5, ${YELLOW_REDUCTION.toFixed(4)} * k);
  ycc.z = mix(ycc.z, 0.5, ${RED_REDUCTION.toFixed(4)} * k);
  outColor = vec4(clamp(yCbCrToRgb(ycc), 0.0, 1.0), src.a);
}
`;

export const skinWhitenPass: Pass<'skinWhiten'> = {
  kind: 'skinWhiten',
  run(env, input, output, layer) {
    const { gpu } = env;
    const amount = Math.min(1, Math.max(0, layer.params.amount));
    const mask = faceMask(env, 'skin');
    const program = mask ? gpu.program('skinWhiten.mask', SHADER(true)) : gpu.program('skinWhiten', SHADER(false));
    gpu.draw(program, output, {
      u_image: input,
      ...(mask ? { u_mask: mask } : {}),
      u_strength: amount * (mask ? 1 : NO_FACE_STRENGTH),
    });
  },
};
