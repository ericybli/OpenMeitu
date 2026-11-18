/**
 * Landmark-driven face reshaping as an inverse map: for every OUTPUT pixel p
 * the shader samples the input at
 *
 *   src(p) = p - sum_i w_i(p) * (t_i + s_i * (p - c_i)),
 *   w_i(p) = (1 - |p - c_i|^2 / r_i^2)^2   inside the radius, else 0.
 *
 * A control with translation t moves the content near its centre c by about
 * t (local translation warp); a control with scale s > 0 magnifies around c
 * by up to 1 / (1 - s) (local bulge). All quantities are in working pixels,
 * so the warp is aspect-correct and follows the landmarks at any resolution.
 *
 * One-to-one guarantee: `buildWarpControls` scales each cluster of
 * overlapping controls so that a rigorous upper bound of the displacement
 * field's Lipschitz constant (see `warpLipschitzBound`) stays below
 * MAX_LIPSCHITZ < 1. The map p -> src(p) is then injective with a Jacobian
 * determinant >= (1 - MAX_LIPSCHITZ)^2: no folding, whatever the parameters.
 */
import type { FaceReshapeParams } from '../engine/types';
import { faceGeometry, type FaceGeometry, type Vec2 } from './regions';
import { MAX_FACES, type Face } from './types';

export interface WarpControl {
  /** Centre in pixels. */
  x: number;
  y: number;
  /** Radius of influence in pixels. */
  radius: number;
  /** Forward translation of the content at the centre, in pixels. */
  tx: number;
  ty: number;
  /** Local magnification strength (0 = none, > 0 enlarge, < 0 shrink), |scale| < 1. */
  scale: number;
}

/** max over s in [0,1] of |d/ds (1 - s^2)^2| = 8 / (3 sqrt 3). */
export const KERNEL_SLOPE = 8 / (3 * Math.sqrt(3));
export const MAX_LIPSCHITZ = 0.8;
/** Folding-guard sampling: node spacing relative to the smallest radius, and a cap on nodes per cluster. */
const GRID_STEP = 0.08;
const MAX_GRID_NODES = 40_000;

/** Faces narrower than this fraction of the image diagonal are left alone. */
const MIN_FACE_FRACTION = 0.015;

// Tuning, as fractions of the face width unless noted.
/** Slim: inward pull of each jaw control at slim = 1 (overlapping kernels add up). */
const SLIM_PULL = 0.03;
const SLIM_RADIUS = 0.26;
/** Positions along the jaw contour (0 = ear level, 1 = chin) and their relative pull. */
const SLIM_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0.18, 0.55],
  [0.34, 0.9],
  [0.5, 1],
  [0.66, 0.85],
  [0.82, 0.5],
];
/** Eyes: centre magnification 1 / (1 - EYE_SCALE) at eyes = 1; radius in eye widths. */
const EYE_SCALE = 0.17;
const EYE_RADIUS = 1.15;
/** Nose: inward pull of each wing as a fraction of the wing-to-wing distance; radius likewise. */
const NOSE_PULL = 0.12;
const NOSE_RADIUS = 0.6;
/**
 * Chin: translation along the face axis and radius, as fractions of the
 * lower-lip-to-chin distance, so the lips stay put while the chin moves.
 */
const CHIN_SHIFT = 0.32;
const CHIN_RADIUS = 1.2;

/** Slim controls on both sides, one per eye, one per nose wing, one at the chin. */
const CONTROLS_PER_FACE = 2 * SLIM_PROFILE.length + 2 + 2 + 1;
/**
 * Size of the shader's control arrays: every control of MAX_FACES faces, so
 * every face is reshaped. A control takes one vec4 (centre, radius, scale)
 * and half of another (translations are packed two per vec4): 1.5 vectors,
 * which keeps MAX_FACES faces within the 224 fragment uniform vectors WebGL2
 * guarantees (checked in tests/unit/warp.test.ts).
 */
export const MAX_WARP_CONTROLS = MAX_FACES * CONTROLS_PER_FACE;
/** Length of the shader's vec4 translation array. */
export const WARP_SHIFT_VECTORS = Math.ceil(MAX_WARP_CONTROLS / 2);

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Point at arc-length fraction `u` (0..1) along an open polyline. */
function alongPolyline(points: readonly Vec2[], u: number): Vec2 {
  const lengths = points.slice(1).map((p, i) => dist(p, points[i]!));
  let remaining = u * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (remaining <= len || i === lengths.length - 1) {
      const f = len > 0 ? Math.min(1, remaining / len) : 0;
      const a = points[i]!;
      const b = points[i + 1]!;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    remaining -= len;
  }
  return points[points.length - 1]!;
}

/** Unit vector from `p` horizontally (in the face frame) towards the face axis. */
function towardsAxis(g: FaceGeometry, p: Vec2): Vec2 {
  const side = dot(sub(p, g.center), g.across);
  return side >= 0 ? { x: -g.across.x, y: -g.across.y } : { ...g.across };
}

function translation(at: Vec2, radius: number, dir: Vec2, amount: number): WarpControl {
  return { x: at.x, y: at.y, radius, tx: dir.x * amount, ty: dir.y * amount, scale: 0 };
}

function faceControls(g: FaceGeometry, params: FaceReshapeParams): WarpControl[] {
  const out: WarpControl[] = [];
  const W = g.faceWidth;

  if (params.slim !== 0) {
    for (const jaw of [g.rightJaw, g.leftJaw]) {
      const contour = [...jaw, g.chin];
      for (const [u, weight] of SLIM_PROFILE) {
        const p = alongPolyline(contour, u);
        out.push(translation(p, W * SLIM_RADIUS, towardsAxis(g, p), params.slim * SLIM_PULL * W * weight));
      }
    }
  }

  if (params.eyes !== 0) {
    for (const eye of [g.rightEye, g.leftEye]) {
      out.push({ x: eye.center.x, y: eye.center.y, radius: eye.width * EYE_RADIUS, tx: 0, ty: 0, scale: params.eyes * EYE_SCALE });
    }
  }

  if (params.nose !== 0) {
    const span = dist(g.rightNoseWing, g.leftNoseWing);
    for (const wing of [g.rightNoseWing, g.leftNoseWing]) {
      out.push(translation(wing, span * NOSE_RADIUS, towardsAxis(g, wing), params.nose * NOSE_PULL * span));
    }
  }

  if (params.chin !== 0) {
    // Positive chin lengthens the face: move the chin away from the forehead.
    const down = { x: -g.up.x, y: -g.up.y };
    const lipToChin = dist(g.mouth.bottom, g.chin);
    out.push(translation(g.chin, lipToChin * CHIN_RADIUS, down, params.chin * CHIN_SHIFT * lipToChin));
  }

  return out.filter((c) => [c.x, c.y, c.radius, c.tx, c.ty, c.scale].every(Number.isFinite) && c.radius > 0);
}

/** Lipschitz bound of one control's displacement field on its own. */
function controlLipschitz(c: WarpControl): number {
  return (Math.hypot(c.tx, c.ty) * KERNEL_SLOPE) / c.radius + Math.abs(c.scale);
}

/**
 * Cheap bound: the field at any point only has contributions from controls
 * overlapping each other, so the worst sum of their individual bounds
 * suffices. Loose where kernels overlap but their gradients cancel.
 */
function overlapBound(controls: readonly WarpControl[]): number {
  let worst = 0;
  for (const c of controls) {
    let sum = 0;
    for (const o of controls) if (overlaps(c, o)) sum += controlLipschitz(o);
    worst = Math.max(worst, sum);
  }
  return worst;
}

/**
 * Tight bound: the exact Jacobian norm sampled on a grid, plus how much it can
 * grow between grid nodes. The Jacobian's own Lipschitz constant per control
 * is <= 8|t|/r^2 (|w''|, |w'/x| <= 8 for the kernel) + 11.1|s|/r (radial and
 * tangential eigenvalues of the bulge term change at <= 8/r and its
 * eigenvectors rotate at <= 2 * KERNEL_SLOPE / r).
 */
function sampledBound(controls: readonly WarpControl[]): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let rMin = Infinity;
  for (const c of controls) {
    x0 = Math.min(x0, c.x - c.radius);
    y0 = Math.min(y0, c.y - c.radius);
    x1 = Math.max(x1, c.x + c.radius);
    y1 = Math.max(y1, c.y + c.radius);
    rMin = Math.min(rMin, c.radius);
  }
  const step = Math.max(rMin * GRID_STEP, Math.sqrt(((x1 - x0) * (y1 - y0)) / MAX_GRID_NODES));
  const reach = step * Math.SQRT1_2; // farthest any point is from its nearest node
  let worst = 0;
  for (let y = y0; y <= y1 + step; y += step) {
    for (let x = x0; x <= x1 + step; x += step) {
      let a = 0;
      let b = 0;
      let c = 0;
      let d = 0;
      let slack = 0;
      for (const k of controls) {
        const dx = x - k.x;
        const dy = y - k.y;
        const r2 = k.radius * k.radius;
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= (k.radius + reach) ** 2) continue;
        slack += reach * ((8 * Math.hypot(k.tx, k.ty)) / r2 + (11.1 * Math.abs(k.scale)) / k.radius);
        if (dist2 >= r2) continue;
        // D = -w (t + s (p - c))  =>  J = -(t + s (p - c)) grad(w)^T - s w I
        const q = dist2 / r2;
        const w = (1 - q) * (1 - q);
        const gx = (-4 * (1 - q) * dx) / r2;
        const gy = (-4 * (1 - q) * dy) / r2;
        const ux = k.tx + k.scale * dx;
        const uy = k.ty + k.scale * dy;
        a -= ux * gx + k.scale * w;
        b -= ux * gy;
        c -= uy * gx;
        d -= uy * gy + k.scale * w;
      }
      // Largest singular value of [[a, b], [c, d]].
      const f = a * a + b * b + c * c + d * d;
      const det = a * d - b * c;
      const norm = Math.sqrt(Math.max(0, (f + Math.sqrt(Math.max(0, f * f - 4 * det * det))) / 2));
      worst = Math.max(worst, norm + slack);
    }
  }
  return worst;
}

/**
 * Upper bound of the Lipschitz constant of the displacement field of
 * `controls` (the operator norm of its Jacobian anywhere in the plane).
 */
export function warpLipschitzBound(controls: readonly WarpControl[]): number {
  if (controls.length === 0) return 0;
  const quick = overlapBound(controls);
  return quick <= MAX_LIPSCHITZ ? quick : Math.min(quick, sampledBound(controls));
}

function overlaps(a: WarpControl, b: WarpControl): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius;
}

/**
 * Scale every cluster of overlapping controls so its Lipschitz bound stays
 * below MAX_LIPSCHITZ. Clusters never share a point, so they are independent.
 */
function preventFolding(controls: WarpControl[]): WarpControl[] {
  const parent = controls.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) if (overlaps(controls[i]!, controls[j]!)) parent[find(i)] = find(j);
  }
  const clusters = new Map<number, number[]>();
  controls.forEach((_, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]));
  const out = controls.slice();
  for (const members of clusters.values()) {
    const bound = warpLipschitzBound(members.map((i) => controls[i]!));
    if (bound <= MAX_LIPSCHITZ) continue;
    const f = MAX_LIPSCHITZ / bound;
    for (const i of members) {
      const c = controls[i]!;
      out[i] = { ...c, tx: c.tx * f, ty: c.ty * f, scale: c.scale * f };
    }
  }
  return out;
}

/**
 * Warp controls for `faces` (normalised landmarks) in a `width` x `height`
 * pixel frame. Returns [] when every parameter is 0. Faces narrower than
 * MIN_FACE_FRACTION of `photoDiagonal` (pixels; default the frame's diagonal)
 * are skipped; of more than MAX_FACES faces, the largest win.
 */
export function buildWarpControls(
  faces: readonly Face[],
  params: FaceReshapeParams,
  width: number,
  height: number,
  photoDiagonal = Math.hypot(width, height),
): WarpControl[] {
  if (params.slim === 0 && params.eyes === 0 && params.nose === 0 && params.chin === 0) return [];
  const minWidth = photoDiagonal * MIN_FACE_FRACTION;
  const geometries = faces
    .map((f) => faceGeometry(f, width, height))
    .filter((g) => g.faceWidth >= minWidth)
    .sort((a, b) => b.faceWidth - a.faceWidth)
    .slice(0, MAX_FACES);
  const controls = geometries.flatMap((g) => faceControls(g, params));
  return preventFolding(controls).slice(0, MAX_WARP_CONTROLS);
}

/**
 * Source pixel sampled for output pixel (x, y): the CPU twin of the shader in
 * passes/faceReshape.ts. Pixel centres are at half-integers.
 */
export function warpSource(controls: readonly WarpControl[], x: number, y: number): Vec2 {
  let sx = x;
  let sy = y;
  for (const c of controls) {
    const dx = x - c.x;
    const dy = y - c.y;
    const q = (dx * dx + dy * dy) / (c.radius * c.radius);
    if (q >= 1) continue;
    const w = (1 - q) * (1 - q);
    sx -= w * (c.tx + c.scale * dx);
    sy -= w * (c.ty + c.scale * dy);
  }
  return { x: sx, y: sy };
}

/** Pack controls into the shader's uniform arrays: `shape` holds a vec4 per control, `shift` a vec4 per two. */
export function packWarpControls(controls: readonly WarpControl[]): { shape: Float32Array; shift: Float32Array; count: number } {
  const count = Math.min(controls.length, MAX_WARP_CONTROLS);
  const shape = new Float32Array(MAX_WARP_CONTROLS * 4);
  const shift = new Float32Array(WARP_SHIFT_VECTORS * 4);
  for (let i = 0; i < count; i++) {
    const c = controls[i]!;
    shape.set([c.x, c.y, c.radius, c.scale], i * 4);
    shift.set([c.tx, c.ty], i * 2);
  }
  return { shape, shift, count };
}
