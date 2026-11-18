import type { TransformParams } from '../../types';
import { GLSL_HEADER } from '../glsl';
import type { Pass } from '../pass';

interface Size {
  width: number;
  height: number;
}

export interface PixelRect extends Size {
  x: number;
  y: number;
}

/**
 * Integer affine map from output pixel (ox, oy) to input pixel:
 * origin + ox * axisX + oy * axisY.
 */
interface PixelMap {
  origin: [number, number];
  axisX: [number, number];
  axisY: [number, number];
}

const FRAGMENT = `${GLSL_HEADER}
uniform sampler2D u_image;
uniform ivec2 u_origin;
uniform ivec2 u_axisX;
uniform ivec2 u_axisY;
void main() {
  // Render-target row 0 is the image top, so gl_FragCoord is the output pixel (x right, y down).
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = texelFetch(u_image, u_origin + p.x * u_axisX + p.y * u_axisY, 0);
}
`;

function rotatedSize(input: Size, rotate: TransformParams['rotate']): Size {
  return rotate === 90 || rotate === 270
    ? { width: input.height, height: input.width }
    : { width: input.width, height: input.height };
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Crop rectangle in pixels of the rotated + flipped image. */
function cropRect(space: Size, crop: TransformParams['crop']): PixelRect {
  if (!crop) return { x: 0, y: 0, ...space };
  const width = clampInt(Math.round(space.width * crop.width), 1, space.width);
  const height = clampInt(Math.round(space.height * crop.height), 1, space.height);
  return {
    x: clampInt(Math.round(space.width * crop.x), 0, space.width - width),
    y: clampInt(Math.round(space.height * crop.y), 0, space.height - height),
    width,
    height,
  };
}

function pixelMap(input: Size, p: TransformParams): PixelMap {
  const rotated = rotatedSize(input, p.rotate);
  const rect = cropRect(rotated, p.crop);
  // Undo crop, then flip, then the clockwise rotation.
  const sourceOf = (ox: number, oy: number): [number, number] => {
    let x = ox + rect.x;
    let y = oy + rect.y;
    if (p.flipH) x = rotated.width - 1 - x;
    if (p.flipV) y = rotated.height - 1 - y;
    switch (p.rotate) {
      case 0:
        return [x, y];
      case 90:
        return [y, input.height - 1 - x];
      case 180:
        return [input.width - 1 - x, input.height - 1 - y];
      case 270:
        return [input.width - 1 - y, x];
    }
  };
  const origin = sourceOf(0, 0);
  const right = sourceOf(1, 0);
  const down = sourceOf(0, 1);
  return {
    origin,
    axisX: [right[0] - origin[0], right[1] - origin[1]],
    axisY: [down[0] - origin[0], down[1] - origin[1]],
  };
}

/**
 * The pixels of `input` (before rotate and flip) that the crop keeps, as an
 * axis-aligned rectangle: exact, because quarter turns and flips map pixel
 * rectangles onto pixel rectangles.
 */
export function cropRegion(input: Size, params: TransformParams): PixelRect {
  const { origin, axisX, axisY } = pixelMap(input, params);
  const out = cropRect(rotatedSize(input, params.rotate), params.crop);
  const far = [0, 1].map((i) => origin[i]! + (out.width - 1) * axisX[i]! + (out.height - 1) * axisY[i]!) as [number, number];
  return {
    x: Math.min(origin[0], far[0]),
    y: Math.min(origin[1], far[1]),
    width: Math.abs(far[0] - origin[0]) + 1,
    height: Math.abs(far[1] - origin[1]) + 1,
  };
}

/** Rotate (clockwise), flip, then crop. Pixel-exact: every output pixel is one input texel. */
export const transformPass: Pass<'transform'> = {
  kind: 'transform',
  outputSize(env, layer) {
    const rect = cropRect(rotatedSize(env, layer.params.rotate), layer.params.crop);
    return { width: rect.width, height: rect.height };
  },
  run(env, input, output, layer) {
    const map = pixelMap(input, layer.params);
    env.gpu.draw(env.gpu.program('pass.transform', FRAGMENT), output, {
      u_image: input,
      u_origin: map.origin,
      u_axisX: map.axisX,
      u_axisY: map.axisY,
    });
  },
};
