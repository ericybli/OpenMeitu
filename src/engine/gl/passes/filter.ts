import { GLSL_HEADER } from '../glsl';
import type { Pass } from '../pass';

const FRAGMENT = `${GLSL_HEADER}
uniform sampler2D u_image;
uniform sampler3D u_lut;
uniform float u_lutSize;
uniform float u_intensity;
void main() {
  vec4 c = texelFetch(u_image, ivec2(gl_FragCoord.xy), 0); // exact, like the adjust pass
  // Map 0..1 onto the centres of the first and last lattice texels.
  vec3 coord = clamp(c.rgb, 0.0, 1.0) * ((u_lutSize - 1.0) / u_lutSize) + 0.5 / u_lutSize;
  vec3 graded = texture(u_lut, coord).rgb;
  outColor = vec4(mix(c.rgb, graded, u_intensity), c.a);
}
`;

/** Colour look through a 3D LUT, blended with the input by `intensity`. */
export const filterPass: Pass<'filter'> = {
  kind: 'filter',
  run(env, input, output, layer) {
    const lut = env.luts.getLut(layer.params.lookId);
    if (!lut) {
      env.gpu.copy(input, output);
      return;
    }
    env.gpu.draw(env.gpu.program('pass.filter', FRAGMENT), output, {
      u_image: input,
      u_lut: lut,
      u_lutSize: lut.width,
      u_intensity: Math.min(1, Math.max(0, layer.params.intensity)),
    });
  },
};
