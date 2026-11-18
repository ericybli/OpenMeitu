import { GLSL_COLOR, GLSL_HEADER } from '../glsl';
import type { Pass } from '../pass';

/** 0 = ellipse matching the frame, 1 = circle. */
const ROUNDNESS = 0.5;
/** Transition width (in centre-to-corner units) at feather 0 and 1. */
const MIN_FEATHER_WIDTH = 0.08;
const MAX_FEATHER_WIDTH = 1;
const FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D u_image;
uniform vec2 u_shape;    // per-axis scale that puts the corners at distance 1
uniform float u_start;
uniform float u_end;
uniform float u_amount;
const float DARKEN_STOPS = 2.5;  // exposure reduction at full effect, amount = -1
const float LIGHTEN_MAX = 0.9;   // blend toward white at full effect, amount = 1
void main() {
  vec4 c = texture(u_image, v_uv);
  float falloff = smoothstep(u_start, u_end, length((v_uv - 0.5) * u_shape));
  float effect = abs(u_amount) * falloff;
  vec3 rgb = u_amount < 0.0
    ? linearToSrgb(srgbToLinear(c.rgb) * exp2(-DARKEN_STOPS * effect))
    : mix(c.rgb, vec3(1.0), LIGHTEN_MAX * effect);
  // Sub-LSB dither against banding in the smooth gradient, only where the effect is visible.
  float dither = (hash12(gl_FragCoord.xy) - 0.5) / 255.0 * min(1.0, effect * 64.0);
  outColor = vec4(clamp(rgb + dither, 0.0, 1.0), c.a);
}
`;

/** Elliptical corner darkening (amount < 0) or lightening toward white (amount > 0). */
export const vignettePass: Pass<'vignette'> = {
  kind: 'vignette',
  run(env, input, output, layer) {
    const { amount, midpoint, feather } = layer.params;
    const aspectScale = (input.width / input.height) ** ROUNDNESS;
    const toCorner = 0.5 * Math.hypot(aspectScale, 1);
    const start = Math.min(1, Math.max(0, midpoint));
    const width = MIN_FEATHER_WIDTH + (MAX_FEATHER_WIDTH - MIN_FEATHER_WIDTH) * Math.min(1, Math.max(0, feather));
    env.gpu.draw(env.gpu.program('pass.vignette', FRAGMENT), output, {
      u_image: input,
      u_shape: [aspectScale / toCorner, 1 / toCorner],
      u_start: start,
      u_end: start + width,
      u_amount: Math.min(1, Math.max(-1, amount)),
    });
  },
};
