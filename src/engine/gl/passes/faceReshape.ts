/**
 * Face reshaping (瘦脸 / 大眼 / 瘦鼻 / 下巴): an inverse-mapping warp driven by
 * landmark control points. The control layout, the folding guard and a CPU
 * reference of this exact mapping live in src/face/warp.ts.
 */
import { buildWarpControls, MAX_WARP_CONTROLS, packWarpControls, WARP_SHIFT_VECTORS } from '../../../face/warp';
import { GLSL_HEADER } from '../glsl';
import type { Pass } from '../pass';

const SHADER = `${GLSL_HEADER}
#define MAX_CONTROLS ${MAX_WARP_CONTROLS}
#define SHIFT_VECTORS ${WARP_SHIFT_VECTORS}
uniform sampler2D u_image;
uniform vec2 u_size;                    // working size in pixels
uniform int u_count;
uniform vec4 u_shape[MAX_CONTROLS];     // centre.xy, radius, scale
uniform vec4 u_shift[SHIFT_VECTORS];    // forward translations of controls 2i (.xy) and 2i + 1 (.zw)
void main() {
  vec2 p = v_uv * u_size;
  vec2 src = p;
  for (int i = 0; i < MAX_CONTROLS; i++) {
    if (i >= u_count) break;
    vec4 c = u_shape[i];
    vec2 d = p - c.xy;
    float q = dot(d, d) / (c.z * c.z);
    if (q >= 1.0) continue;
    float w = (1.0 - q) * (1.0 - q);
    vec4 pair = u_shift[i / 2];
    src -= w * ((i % 2 == 0 ? pair.xy : pair.zw) + c.w * d);
  }
  outColor = texture(u_image, src / u_size);
}
`;

export const faceReshapePass: Pass<'faceReshape'> = {
  kind: 'faceReshape',
  run(env, input, output, layer) {
    const { gpu } = env;
    const controls = env.face
      ? buildWarpControls(env.face.faces, layer.params, env.width, env.height, env.sourceDiagonal * env.scale)
      : [];
    if (controls.length === 0) {
      gpu.copy(input, output);
      return;
    }
    const { shape, shift, count } = packWarpControls(controls);
    gpu.draw(gpu.program('faceReshape', SHADER), output, {
      u_image: input,
      u_size: [env.width, env.height],
      u_count: count,
      u_shape: shape,
      u_shift: shift,
    });
  },
};
