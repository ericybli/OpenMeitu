/**
 * Facial regions and derived geometry on MediaPipe's 478-point canonical face
 * mesh.
 *
 * "right"/"left" always mean the SUBJECT's side (MediaPipe's convention), so
 * in an unmirrored photo the right eye appears on the image's left.
 *
 * Region outlines are ordered index rings derived from the landmark
 * connection lists of @mediapipe/tasks-vision (Apache-2.0); only a few small,
 * well-known index groups (nose outline, nostrils) are listed by hand.
 */
import type { Face } from './types';

/** A point in pixels of some image frame (x right, y down). */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * The FaceLandmarker.FACE_LANDMARKS_* connection lists of
 * @mediapipe/tasks-vision 1.2.3 (Apache-2.0), written as chains of
 * consecutive connections in their original order. They are kept here as data
 * so the renderer does not load the MediaPipe bundle, which the app imports
 * lazily for detection only; tests/unit/regions.test.ts checks them against
 * the package.
 */
export const MEDIAPIPE_CONNECTION_CHAINS = {
  FACE_LANDMARKS_FACE_OVAL: [
    [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
  ],
  FACE_LANDMARKS_LIPS: [
    [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
    [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
    [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308],
    [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308],
  ],
  FACE_LANDMARKS_RIGHT_EYE: [
    [33, 7, 163, 144, 145, 153, 154, 155, 133],
    [33, 246, 161, 160, 159, 158, 157, 173, 133],
  ],
  FACE_LANDMARKS_LEFT_EYE: [
    [263, 249, 390, 373, 374, 380, 381, 382, 362],
    [263, 466, 388, 387, 386, 385, 384, 398, 362],
  ],
  FACE_LANDMARKS_RIGHT_EYEBROW: [
    [46, 53, 52, 65, 55],
    [70, 63, 105, 66, 107],
  ],
  FACE_LANDMARKS_LEFT_EYEBROW: [
    [276, 283, 282, 295, 285],
    [300, 293, 334, 296, 336],
  ],
  FACE_LANDMARKS_RIGHT_IRIS: [[469, 470, 471, 472, 469]],
  FACE_LANDMARKS_LEFT_IRIS: [[474, 475, 476, 477, 474]],
} as const satisfies Record<string, ReadonlyArray<readonly number[]>>;

type ChainList = ReadonlyArray<readonly number[]>;

/** A chain that returns to its first index, as a ring (first index not repeated). */
function closedChainRing(chains: ChainList): number[] {
  const chain = chains[0];
  if (!chain || chain[0] !== chain[chain.length - 1]) throw new Error('Landmark chain is not closed');
  return chain.slice(0, -1);
}

/**
 * Join two chains running in the same direction (e.g. lower and upper eyelid,
 * both outer corner -> inner corner) into one ring. Shared end points are
 * kept once.
 */
function twoChainRing(chains: ChainList, first = 0): number[] {
  const a = chains[first];
  const b = chains[first + 1];
  if (!a || !b) throw new Error('Unexpected landmark connection layout');
  const back = b.slice().reverse();
  if (back[0] === a[a.length - 1]) back.shift();
  if (back[back.length - 1] === a[0]) back.pop();
  return [...a, ...back];
}

const MP = MEDIAPIPE_CONNECTION_CHAINS;

/** Ordered landmark index rings (closed polygons; the first index is not repeated). */
export const REGION_RINGS = {
  faceOval: closedChainRing(MP.FACE_LANDMARKS_FACE_OVAL),
  /** Outer lip contour (lips + mouth opening). */
  lipsOuter: twoChainRing(MP.FACE_LANDMARKS_LIPS, 0),
  /** Inner lip contour: the mouth opening (teeth, tongue, gums). */
  mouthInner: twoChainRing(MP.FACE_LANDMARKS_LIPS, 2),
  rightEye: twoChainRing(MP.FACE_LANDMARKS_RIGHT_EYE),
  leftEye: twoChainRing(MP.FACE_LANDMARKS_LEFT_EYE),
  rightBrow: twoChainRing(MP.FACE_LANDMARKS_RIGHT_EYEBROW),
  leftBrow: twoChainRing(MP.FACE_LANDMARKS_LEFT_EYEBROW),
  rightIris: closedChainRing(MP.FACE_LANDMARKS_RIGHT_IRIS),
  leftIris: closedChainRing(MP.FACE_LANDMARKS_LEFT_IRIS),
  /** Nose from the bridge between the eyes down around both wings. */
  nose: [168, 417, 351, 412, 399, 437, 420, 429, 279, 358, 294, 327, 326, 2, 97, 98, 64, 129, 49, 209, 198, 217, 174, 188, 122, 193],
  rightNostril: [75, 79, 239, 238, 20, 99],
  leftNostril: [305, 309, 459, 458, 250, 328],
} as const satisfies Record<string, readonly number[]>;

export type RegionName = keyof typeof REGION_RINGS;

/** Well-known single landmarks of the canonical mesh. */
export const LANDMARK = {
  foreheadTop: 10,
  noseBridge: 168,
  noseTip: 1,
  chin: 152,
  rightEyeOuter: 33,
  rightEyeInner: 133,
  rightEyeUpper: 159,
  rightEyeLower: 145,
  leftEyeOuter: 263,
  leftEyeInner: 362,
  leftEyeUpper: 386,
  leftEyeLower: 374,
  rightIrisCenter: 468,
  leftIrisCenter: 473,
  /** Outermost point of each nose wing (ala). */
  rightNoseWing: 64,
  leftNoseWing: 294,
  rightMouthCorner: 61,
  leftMouthCorner: 291,
  upperLipTop: 0,
  lowerLipBottom: 17,
  /** Face-oval points level with the ears; they bound the jaw contour from above. */
  rightCheekTop: 234,
  leftCheekTop: 454,
} as const;

/** Midline landmarks used to place the face axis. */
const MIDLINE = [LANDMARK.foreheadTop, LANDMARK.noseBridge, LANDMARK.noseTip, LANDMARK.chin] as const;

/** Landmark `index` of `face` in pixels of a `width` x `height` frame. */
export function landmarkPx(face: Face, index: number, width: number, height: number): Vec2 {
  const p = face.landmarks[index];
  if (!p) throw new Error(`Face has no landmark ${index}`);
  return { x: p.x * width, y: p.y * height };
}

/** Region outline in pixels of a `width` x `height` frame. */
export function regionPolygon(face: Face, region: RegionName, width: number, height: number): Vec2[] {
  return REGION_RINGS[region].map((i) => landmarkPx(face, i, width, height));
}

export interface EyeGeometry {
  /** Centroid of the eyelid contour. */
  center: Vec2;
  /** Corner-to-corner width. */
  width: number;
  /** Lid opening at the middle of the eye. */
  height: number;
  /** Half the width; a convenient size for eye-centred effects. */
  radius: number;
}

export interface MouthGeometry {
  center: Vec2;
  /** Corner-to-corner width. */
  width: number;
  /** Lowest point of the lower lip on the midline. */
  bottom: Vec2;
}

/** Face geometry in pixels of one frame; all lengths are aspect-correct pixels. */
export interface FaceGeometry {
  width: number;
  height: number;
  /** A point on the facial midline, roughly between the eyes and the chin. */
  center: Vec2;
  /** Unit vector along the face axis, chin -> forehead. */
  up: Vec2;
  /** Unit vector perpendicular to `up`, from the subject's right side to their left. */
  across: Vec2;
  /** Distance between the face-oval points level with the ears. */
  faceWidth: number;
  /** Distance from the upper forehead landmark to the chin. */
  faceHeight: number;
  /** Distance between the eye centres. */
  interOcular: number;
  rightEye: EyeGeometry;
  leftEye: EyeGeometry;
  /** Contour points per side, ordered from ear level down towards (excluding) the chin. */
  rightJaw: Vec2[];
  leftJaw: Vec2[];
  chin: Vec2;
  noseTip: Vec2;
  rightNoseWing: Vec2;
  leftNoseWing: Vec2;
  mouth: MouthGeometry;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  return len > 0 ? { x: v.x / len, y: v.y / len } : { x: 0, y: -1 };
}

function mean(points: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function eyeGeometry(face: Face, ring: readonly number[], corners: [number, number], lids: [number, number], w: number, h: number): EyeGeometry {
  const center = mean(ring.map((i) => landmarkPx(face, i, w, h)));
  const width = dist(landmarkPx(face, corners[0], w, h), landmarkPx(face, corners[1], w, h));
  const height = dist(landmarkPx(face, lids[0], w, h), landmarkPx(face, lids[1], w, h));
  return { center, width, height, radius: width / 2 };
}

/** Face-oval indices from `from` to `to` (both included), walking the shorter way round. */
function ovalPath(from: number, to: number): number[] {
  const ring = REGION_RINGS.faceOval;
  const n = ring.length;
  const start = ring.indexOf(from);
  const end = ring.indexOf(to);
  if (start < 0 || end < 0) throw new Error('Landmark not on the face oval');
  const forward: number[] = [];
  for (let k = start; ; k = (k + 1) % n) {
    forward.push(ring[k]!);
    if (k === end) break;
  }
  const backward: number[] = [];
  for (let k = start; ; k = (k - 1 + n) % n) {
    backward.push(ring[k]!);
    if (k === end) break;
  }
  return forward.length <= backward.length ? forward : backward;
}

/** Jaw contour indices per side, ear level -> chin (chin excluded). */
export const JAW_INDICES = {
  right: ovalPath(LANDMARK.rightCheekTop, LANDMARK.chin).slice(0, -1),
  left: ovalPath(LANDMARK.leftCheekTop, LANDMARK.chin).slice(0, -1),
} as const;

/** Derive pixel-space geometry of `face` in a `width` x `height` frame. */
export function faceGeometry(face: Face, width: number, height: number): FaceGeometry {
  const px = (i: number) => landmarkPx(face, i, width, height);
  const rightEye = eyeGeometry(
    face,
    REGION_RINGS.rightEye,
    [LANDMARK.rightEyeOuter, LANDMARK.rightEyeInner],
    [LANDMARK.rightEyeUpper, LANDMARK.rightEyeLower],
    width,
    height,
  );
  const leftEye = eyeGeometry(
    face,
    REGION_RINGS.leftEye,
    [LANDMARK.leftEyeOuter, LANDMARK.leftEyeInner],
    [LANDMARK.leftEyeUpper, LANDMARK.leftEyeLower],
    width,
    height,
  );
  const chin = px(LANDMARK.chin);
  const forehead = px(LANDMARK.foreheadTop);

  // Average two independent estimates of the face's up direction: the
  // chin -> forehead line and the perpendicular of the eye line.
  const eyeLine = normalize({ x: leftEye.center.x - rightEye.center.x, y: leftEye.center.y - rightEye.center.y });
  const fromEyes = { x: eyeLine.y, y: -eyeLine.x };
  const fromMidline = normalize({ x: forehead.x - chin.x, y: forehead.y - chin.y });
  const up = normalize({ x: fromEyes.x + fromMidline.x, y: fromEyes.y + fromMidline.y });
  const across = { x: -up.y, y: up.x };

  const mouthRight = px(LANDMARK.rightMouthCorner);
  const mouthLeft = px(LANDMARK.leftMouthCorner);

  return {
    width,
    height,
    center: mean(MIDLINE.map(px)),
    up,
    across,
    faceWidth: dist(px(LANDMARK.rightCheekTop), px(LANDMARK.leftCheekTop)),
    faceHeight: dist(forehead, chin),
    interOcular: dist(rightEye.center, leftEye.center),
    rightEye,
    leftEye,
    rightJaw: JAW_INDICES.right.map(px),
    leftJaw: JAW_INDICES.left.map(px),
    chin,
    noseTip: px(LANDMARK.noseTip),
    rightNoseWing: px(LANDMARK.rightNoseWing),
    leftNoseWing: px(LANDMARK.leftNoseWing),
    mouth: {
      center: mean(REGION_RINGS.mouthInner.map(px)),
      width: dist(mouthRight, mouthLeft),
      bottom: px(LANDMARK.lowerLipBottom),
    },
  };
}
