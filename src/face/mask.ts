/**
 * Landmark-derived region masks (skin, teeth) rasterised into GPU textures,
 * plus the colour-based skin likelihood shared by the skin passes.
 *
 * Masks are white-on-black and feathered with Gaussian blurs proportional to
 * each face's size, so effects fade in without visible seams.
 */
import { gaussianBlur } from '../engine/gl/blur';
import { GLSL_HEADER } from '../engine/gl/glsl';
import type { Gpu, GpuTexture, RenderTarget } from '../engine/gl/gpu';
import type { PassEnv } from '../engine/gl/pass';
import { faceGeometry, landmarkPx, LANDMARK, regionPolygon, type FaceGeometry, type RegionName, type Vec2 } from './regions';
import type { Face } from './types';

export type FaceMaskKind = 'skin' | 'teeth';

/** Longest edge of a rasterised mask. Masks are soft, so this only bounds the cost. */
const MASK_MAX_EDGE = 2048;

// Skin mask tuning; all sizes are fractions of the face width.
/** Feather of the face area and of the feature holes. */
const SKIN_FEATHER = 0.022;
/** Grow the face oval outwards so smoothing reaches the very edge of the cheeks. */
const SKIN_OVAL_GROW = 0.02;
/**
 * Stretch the part of the oval above the eyes upwards by this fraction of its
 * height above the eye line. MediaPipe's oval stops short of the hairline;
 * the colour likelihood keeps hair out of the extended area.
 */
const SKIN_FOREHEAD_STRETCH = 0.32;
/**
 * The surround (ears, neck) keeps retouching consistent between the face and
 * the skin around it. It is feathered widely so it fades out gradually, and
 * only skin-coloured pixels inside it are affected.
 */
const SURROUND_SIDE = 0.24;
const SURROUND_NECK_DEPTH = 0.95;
const SURROUND_NECK_HALF_WIDTH = 0.4;
const SURROUND_FEATHER = 0.11;

interface FeatureHole {
  region: RegionName;
  /** Dilation for texture smoothing, so lashes, brow hairs and the lip line stay crisp. */
  retouchGrow: number;
  /** Dilation for tone changes, which may reach right up to the feature. */
  toneGrow: number;
}

const SKIN_HOLES: readonly FeatureHole[] = [
  { region: 'rightEye', retouchGrow: 0.035, toneGrow: 0.012 },
  { region: 'leftEye', retouchGrow: 0.035, toneGrow: 0.012 },
  { region: 'rightBrow', retouchGrow: 0.035, toneGrow: 0.015 },
  { region: 'leftBrow', retouchGrow: 0.035, toneGrow: 0.015 },
  { region: 'lipsOuter', retouchGrow: 0.03, toneGrow: 0.015 },
  { region: 'rightNostril', retouchGrow: 0.02, toneGrow: 0.01 },
  { region: 'leftNostril', retouchGrow: 0.02, toneGrow: 0.01 },
];
/** Teeth feathering, as a fraction of the mouth width. */
const TEETH_FEATHER = 0.025;

/**
 * GLSL: `float skinColorLikelihood(vec3 rgb)` — soft 0..1 likelihood that a
 * display-referred sRGB colour is skin. It looks at the chroma direction in
 * the YCbCr plane, which is much the same for light and dark skin, so it is
 * tolerant of skin tone and exposure; it rejects neutral greys, blues and
 * greens, saturated reds and near-black pixels (hair, pupils, deep shadow).
 * Requires GLSL_COLOR.
 */
export const SKIN_LIKELIHOOD_GLSL = `
float skinColorLikelihood(vec3 rgb) {
  vec3 ycc = rgbToYCbCr(rgb);
  // x: yellow (-Cb), y: red (+Cr). Skin of every tone sits around 53 degrees.
  vec2 chroma = vec2(0.5 - ycc.y, ycc.z - 0.5);
  float rho = length(chroma);
  // Neutral colours are never skin, and atan(0, 0) is undefined in GLSL.
  if (rho < 0.012) return 0.0;
  float hue = degrees(atan(chroma.y, chroma.x));
  float hueTerm = 1.0 - smoothstep(15.0, 32.0, abs(hue - 53.0));
  float chromaTerm = smoothstep(0.012, 0.04, rho) * (1.0 - smoothstep(0.19, 0.27, rho));
  float lumaTerm = smoothstep(0.05, 0.17, ycc.x);
  return hueTerm * chromaTerm * lumaTerm;
}
`;

/**
 * Skin texture effects run at up to this many scales, each half the previous
 * one, so faces of different sizes in one photo are each treated at about
 * their own scale.
 */
export const SKIN_SCALE_LEVELS = 3;

/** Scale levels within this distance of a computed level are clamped onto it (log2 units). */
const SHARED_LEVEL_TOLERANCE = 0.3;

export interface SkinScale {
  /** Reference length in working pixels: the largest face's width, or a fraction of the image diagonal without faces. */
  px: number;
  /** Scales needed (1..SKIN_SCALE_LEVELS); scale k uses px / 2^k. */
  levels: number;
}

/** Scale level of a face of `width` next to the largest one: log2(largest / width), clamped. */
function scaleLevel(width: number, largest: number): number {
  return width > 0 ? Math.min(SKIN_SCALE_LEVELS - 1, Math.max(0, Math.log2(largest / width))) : SKIN_SCALE_LEVELS - 1;
}

/** The scales skin texture effects need for the faces of `env`. */
export function skinScale(env: PassEnv): SkinScale {
  const widths = (env.face?.faces ?? []).map((face) => faceGeometry(face, env.width, env.height).faceWidth).filter((w) => w > 0);
  // Without faces, size from the whole photo, so cropping doesn't change the result.
  if (widths.length === 0) return { px: env.sourceDiagonal * env.scale * 0.22, levels: 1 };
  const largest = Math.max(...widths);
  const deepest = Math.max(...widths.map((w) => scaleLevel(w, largest)));
  // Faces up to ~19% smaller than the largest share its scale; the difference is not visible.
  return { px: largest, levels: Math.ceil(deepest - SHARED_LEVEL_TOLERANCE) + 1 };
}

/**
 * Feathered mask of `kind` covering every detected face at the pass's working
 * size, or null when there is no face. Cached until the source, analysis or
 * working size changes.
 *
 * - `skin`: the face (oval stretched over the forehead) at full strength,
 *   fading out over the ears and neck, with every face's eyes, brows, lips
 *   and nostrils cut out. Multiply by `skinColorLikelihood` to get skin.
 *   `.r` (retouch) cuts the features out with a margin that keeps lashes,
 *   brow hairs and the lip line away from texture smoothing; `.g` (tone)
 *   cuts out only the features themselves, so tone changes reach the skin
 *   right around the eyes and lips instead of leaving darker rings.
 *   `.b` holds the scale level of the face covering each pixel, divided by
 *   SKIN_SCALE_LEVELS - 1 (see `skinScale`).
 * - `teeth`: the mouth opening, in `.r` and `.g`.
 */
export function faceMask(env: PassEnv, kind: FaceMaskKind): GpuTexture | null {
  const analysis = env.face;
  if (!analysis || analysis.faces.length === 0) return null;
  const { gpu, width, height } = env;
  return env.cache.get(
    `face-mask:${kind}:${width}x${height}`,
    () => buildMask(gpu, analysis.faces, kind, width, height),
    (tex) => gpu.deleteTexture(tex),
  );
}

/**
 * Faces are rasterised with one region per channel — R: area, G: surround,
 * B: tone holes in one raster, B: retouch holes in a second one — and
 * accumulated over faces as (max area, product of retouch keeps, product of
 * tone keeps, scale code of the face with the largest area), so a hole of any
 * face cuts every face's area.
 */
const ACCUMULATE_SHADER = `${GLSL_HEADER}
uniform sampler2D u_sharp;          // R: area, B: tone holes (sharp feather)
uniform sampler2D u_soft;           // G: surround (wide feather)
uniform sampler2D u_retouchHoles;   // B: retouch holes (sharp feather)
uniform sampler2D u_previous;
uniform float u_hasPrevious;
uniform float u_scaleCode;
void main() {
  vec3 sharp = texture(u_sharp, v_uv).rgb;
  float area = max(sharp.r, texture(u_soft, v_uv).g);
  vec4 acc = vec4(area, 1.0 - texture(u_retouchHoles, v_uv).b, 1.0 - sharp.b, u_scaleCode);
  if (u_hasPrevious > 0.5) {
    vec4 previous = texture(u_previous, v_uv);
    acc = vec4(max(acc.x, previous.x), acc.yz * previous.yz, acc.x >= previous.x ? acc.w : previous.w);
  }
  outColor = acc;
}
`;

const FINALIZE_SHADER = `${GLSL_HEADER}
uniform sampler2D u_acc;
void main() {
  vec4 acc = texture(u_acc, v_uv);
  outColor = vec4(acc.x * acc.y, acc.x * acc.z, acc.w, 1.0);
}
`;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const AREA = '#f00';
const SURROUND = '#0f0';
const HOLE = '#00f';

function createCanvas(width: number, height: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx2D } {
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas unavailable for mask rasterisation');
  return { canvas, ctx };
}

function pathOf(points: readonly Vec2[]): Path2D {
  const path = new Path2D();
  points.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
  path.closePath();
  return path;
}

/** Fill `points` in `color` and, with `grow` > 0, dilate by `grow` pixels using a round-joined stroke. */
function fillRegion(ctx: Ctx2D, points: readonly Vec2[], color: string, grow = 0): void {
  const path = pathOf(points);
  ctx.fillStyle = ctx.strokeStyle = color;
  ctx.fill(path);
  if (grow > 0) {
    ctx.lineWidth = grow * 2;
    ctx.stroke(path);
  }
}

function offset(p: Vec2, dir: Vec2, amount: number): Vec2 {
  return { x: p.x + dir.x * amount, y: p.y + dir.y * amount };
}

/** Face oval stretched up over the forehead (see SKIN_FOREHEAD_STRETCH). */
function skinArea(face: Face, g: FaceGeometry, width: number, height: number): Vec2[] {
  const eyeMid = { x: (g.rightEye.center.x + g.leftEye.center.x) / 2, y: (g.rightEye.center.y + g.leftEye.center.y) / 2 };
  return regionPolygon(face, 'faceOval', width, height).map((p) => {
    const above = (p.x - eyeMid.x) * g.up.x + (p.y - eyeMid.y) * g.up.y;
    return offset(p, g.up, Math.max(0, above) * SKIN_FOREHEAD_STRETCH);
  });
}

/** Ears and neck: the lower face widened sideways and extended down below the chin. */
function skinSurround(face: Face, g: FaceGeometry, width: number, height: number): Vec2[] {
  const W = g.faceWidth;
  const left = g.across;
  const right = { x: -g.across.x, y: -g.across.y };
  const down = { x: -g.up.x, y: -g.up.y };
  const neckBottom = offset(g.chin, down, W * SURROUND_NECK_DEPTH);
  // Jaw contours start at the cheek-top landmarks, level with the ears.
  return [
    ...g.rightJaw.map((p) => offset(p, right, W * SURROUND_SIDE)),
    offset(neckBottom, right, W * SURROUND_NECK_HALF_WIDTH),
    offset(neckBottom, left, W * SURROUND_NECK_HALF_WIDTH),
    ...g.leftJaw.map((p) => offset(p, left, W * SURROUND_SIDE)).reverse(),
  ];
}

interface Raster {
  /** Draws onto a black canvas with additive compositing, so channels are independent. */
  draw(ctx: Ctx2D): void;
  /** Gaussian feather radii (pixels); the raster is blurred once per entry. */
  feathers: readonly number[];
}

/** Blurred copies of `raster`, one per feather radius. Release them when done. */
function rasterise(gpu: Gpu, canvas: OffscreenCanvas | HTMLCanvasElement, ctx: Ctx2D, raster: Raster): RenderTarget[] {
  const { width, height } = canvas;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineJoin = 'round';
  raster.draw(ctx);
  ctx.globalCompositeOperation = 'source-over';
  const texture = gpu.uploadImage(canvas);
  const blurred = raster.feathers.map((sigma) => {
    const target = gpu.acquire(width, height);
    gaussianBlur(gpu, texture, target, sigma);
    return target;
  });
  gpu.deleteTexture(texture);
  return blurred;
}

/**
 * The rasters of one face: `sharp` (R: area, B: tone holes), `soft`
 * (G: surround) and `retouchHoles` (B), possibly the same targets.
 */
function rasteriseFace(
  gpu: Gpu,
  canvas: OffscreenCanvas | HTMLCanvasElement,
  ctx: Ctx2D,
  face: Face,
  kind: FaceMaskKind,
): { sharp: RenderTarget; soft: RenderTarget; retouchHoles: RenderTarget; release(): void } {
  const { width, height } = canvas;
  const g = faceGeometry(face, width, height);
  if (kind === 'teeth') {
    const [mouth] = rasterise(gpu, canvas, ctx, {
      draw: (c) => fillRegion(c, regionPolygon(face, 'mouthInner', width, height), AREA),
      feathers: [g.mouth.width * TEETH_FEATHER],
    });
    return { sharp: mouth!, soft: mouth!, retouchHoles: mouth!, release: () => gpu.release(mouth!) };
  }
  const W = g.faceWidth;
  const [sharp, soft] = rasterise(gpu, canvas, ctx, {
    draw: (c) => {
      fillRegion(c, skinArea(face, g, width, height), AREA, W * SKIN_OVAL_GROW);
      fillRegion(c, skinSurround(face, g, width, height), SURROUND);
      for (const hole of SKIN_HOLES) fillRegion(c, regionPolygon(face, hole.region, width, height), HOLE, W * hole.toneGrow);
    },
    feathers: [W * SKIN_FEATHER, W * SURROUND_FEATHER],
  });
  const [retouchHoles] = rasterise(gpu, canvas, ctx, {
    draw: (c) => {
      for (const hole of SKIN_HOLES) fillRegion(c, regionPolygon(face, hole.region, width, height), HOLE, W * hole.retouchGrow);
    },
    feathers: [W * SKIN_FEATHER],
  });
  return {
    sharp: sharp!,
    soft: soft!,
    retouchHoles: retouchHoles!,
    release: () => {
      gpu.release(sharp!);
      gpu.release(soft!);
      gpu.release(retouchHoles!);
    },
  };
}

function buildMask(gpu: Gpu, faces: readonly Face[], kind: FaceMaskKind, width: number, height: number): RenderTarget {
  const s = Math.min(1, MASK_MAX_EDGE / Math.max(width, height));
  const mw = Math.max(1, Math.round(width * s));
  const mh = Math.max(1, Math.round(height * s));
  const { canvas, ctx } = createCanvas(mw, mh);
  const accumulate = gpu.program('faceMask.accumulate', ACCUMULATE_SHADER);
  const faceWidths = faces.map((face) => faceGeometry(face, width, height).faceWidth);
  const largest = Math.max(...faceWidths);
  let acc: RenderTarget | null = null;
  // Each face is feathered with its own radii.
  for (const [i, face] of faces.entries()) {
    const rasters = rasteriseFace(gpu, canvas, ctx, face, kind);
    const next = gpu.acquire(mw, mh);
    gpu.draw(accumulate, next, {
      u_sharp: rasters.sharp,
      u_soft: rasters.soft,
      u_retouchHoles: rasters.retouchHoles,
      u_previous: acc ?? rasters.sharp,
      u_hasPrevious: acc ? 1 : 0,
      u_scaleCode: scaleLevel(faceWidths[i]!, largest) / (SKIN_SCALE_LEVELS - 1),
    });
    rasters.release();
    if (acc) gpu.release(acc);
    acc = next;
  }
  if (!acc) throw new Error('faceMask: no faces');
  const mask = gpu.createTarget(mw, mh);
  gpu.draw(gpu.program('faceMask.finalize', FINALIZE_SHADER), mask, { u_acc: acc });
  gpu.release(acc);
  return mask;
}
