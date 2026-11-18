import { GLSL_COLOR, GLSL_HEADER } from '../glsl';
import type { Pass } from '../pass';

/**
 * Grain cell size range, selected by `size`, in pixels of a photo with a
 * REFERENCE_DIAGONAL px diagonal. Cells scale with the photo, so a setting
 * looks the same on any photo at the same display size.
 */
const CELL_MIN = 1;
const CELL_MAX = 4;
const REFERENCE_DIAGONAL = 3000;
/** Finer cells cannot be represented at the working resolution. */
const MIN_WORKING_CELL = 0.5;
/** Standard deviation of the grain (sRGB units) in pure midtones at amount = 1. */
const MAX_STRENGTH = 0.04;
/** Gaussian radius of one grain blob, in cells. */
const BLOB_SIGMA = 0.5;
/** Variance of the triangular impulse values on [-1, 1]. */
const IMPULSE_VARIANCE = 1 / 6;

const FRAGMENT = `${GLSL_HEADER}
${GLSL_COLOR}
uniform sampler2D u_image;
uniform vec2 u_cells;     // image size measured in grain cells
uniform float u_strength;

const float BLOB_FALLOFF = ${(0.5 / BLOB_SIGMA ** 2).toFixed(6)};
// With one impulse per cell at a uniformly jittered position, E[sum g^2] equals
// the integral of g^2 = pi * sigma^2, independent of position.
const float UNIT_VARIANCE = ${(1 / Math.sqrt(Math.PI * BLOB_SIGMA ** 2 * IMPULSE_VARIANCE)).toFixed(6)};

// PCG-based 3D integer hash (Jarzynski & Olano, "Hash Functions for GPU
// Rendering", JCGT 2020): exact for any image size, unlike float hashes.
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

// Sparse-convolution noise: every cell holds one impulse at a random position
// with a random zero-mean value, splatted with a Gaussian blob. Because the
// jitter covers the whole cell, the covariance is stationary and isotropic,
// so no lattice shows. Returns unit variance.
float grainNoise(vec2 p) {
  // The 4x4 cells around p: impulses outside are >= 1.5 cells (3 sigma) away.
  ivec2 first = ivec2(floor(p - 0.5)) - 1;
  float sum = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      ivec2 cell = first + ivec2(i, j);
      // p >= 0, so cell >= -2; the bias keeps the hash input non-negative.
      uvec3 h = pcg3d(uvec3(uvec2(cell + 2), 0x2545f491u));
      vec2 impulse = vec2(cell) + vec2(h.xy >> 8u) * (1.0 / 16777216.0);
      // Sum of two 16-bit uniforms: triangular distribution on [-1, 1].
      float value = float((h.z >> 16u) + (h.z & 0xffffu)) * (1.0 / 65535.0) - 1.0;
      vec2 d = p - impulse;
      sum += value * exp(-dot(d, d) * BLOB_FALLOFF);
    }
  }
  return sum * UNIT_VARIANCE;
}

void main() {
  vec4 c = texture(u_image, v_uv);
  float l = clamp(luma(c.rgb), 0.0, 1.0);
  float midtones = 4.0 * l * (1.0 - l);
  float grain = grainNoise(v_uv * u_cells) * u_strength * midtones;
  outColor = vec4(clamp(c.rgb + grain, 0.0, 1.0), c.a);
}
`;

/**
 * Fraction of the grain's standard deviation that survives when grain made
 * at the reference resolution is box-downsampled to `scale`. The grain has a
 * Gaussian autocorrelation, and a box of B = 1/scale pixel samples has
 * variance (B^2 - 1) / 12; combining the two Gaussians gives
 * sigma / sqrt(sigma^2 + (1 - scale^2) / 12) in working px.
 */
function downsampledGrainFraction(blobSigmaWorking: number, scale: number): number {
  const boxVariance = (1 - scale * scale) / 12;
  return blobSigmaWorking / Math.sqrt(blobSigmaWorking * blobSigmaWorking + boxVariance);
}

/**
 * Deterministic luminance film grain, strongest in the midtones. The noise
 * field is defined relative to the photo's diagonal, so preview and export
 * show the same pattern and photos of any resolution the same grain. Wherever
 * the working image has fewer pixels than the reference resolution (previews,
 * small photos), it shows what downsampling reference-resolution grain would
 * show: cells too fine for the working resolution are clamped, and the
 * amplitude is lowered by the amount box-averaging would remove.
 */
export const grainPass: Pass<'grain'> = {
  kind: 'grain',
  run(env, input, output, layer) {
    const { amount, size } = layer.params;
    const cellReference = CELL_MIN + (CELL_MAX - CELL_MIN) * Math.min(1, Math.max(0, size));
    const workingPerReference = (env.sourceDiagonal * env.scale) / REFERENCE_DIAGONAL;
    const cellWorking = cellReference * workingPerReference;
    const cell = Math.max(MIN_WORKING_CELL, cellWorking);
    const visible = downsampledGrainFraction(BLOB_SIGMA * cellWorking, Math.min(1, workingPerReference));
    env.gpu.draw(env.gpu.program('pass.grain', FRAGMENT), output, {
      u_image: input,
      u_cells: [input.width / cell, input.height / cell],
      u_strength: MAX_STRENGTH * Math.min(1, Math.max(0, amount)) * visible,
    });
  },
};
