import { readFileSync } from 'node:fs';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { describe, expect, it } from 'vitest';
import {
  JAW_INDICES,
  LANDMARK,
  MEDIAPIPE_CONNECTION_CHAINS,
  REGION_RINGS,
  faceGeometry,
  regionPolygon,
  type RegionName,
  type Vec2,
} from '../../src/face/regions';
import type { FaceAnalysis } from '../../src/face/types';

function loadFixture(name: string): FaceAnalysis {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.faces.json`, import.meta.url), 'utf8')) as FaceAnalysis;
}

const FIXTURES = ['portrait-a', 'portrait-b'].map((name) => ({ name, analysis: loadFixture(name) }));
const REGIONS = Object.keys(REGION_RINGS) as RegionName[];

function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function isSimple(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      if (segmentsCross(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

function contains(poly: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function edgeLengths(poly: readonly Vec2[]): number[] {
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    return Math.hypot(q.x - p.x, q.y - p.y);
  });
}

describe('region index rings', () => {
  it.each(Object.keys(MEDIAPIPE_CONNECTION_CHAINS) as Array<keyof typeof MEDIAPIPE_CONNECTION_CHAINS>)(
    'embeds %s exactly as @mediapipe/tasks-vision defines it',
    (key) => {
      const fromChains = MEDIAPIPE_CONNECTION_CHAINS[key].flatMap((chain) =>
        chain.slice(1).map((end, i) => ({ start: chain[i]!, end })),
      );
      expect(fromChains).toEqual(FaceLandmarker[key].map(({ start, end }) => ({ start, end })));
    },
  );

  it.each(REGIONS)('%s is a ring of distinct mesh indices', (region) => {
    const ring = REGION_RINGS[region];
    expect(ring.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ring).size).toBe(ring.length);
    for (const i of ring) {
      expect(Number.isInteger(i)).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(478);
    }
  });

  it('derives the expected rings from the MediaPipe connection lists', () => {
    expect(REGION_RINGS.faceOval).toHaveLength(36);
    expect(REGION_RINGS.faceOval[0]).toBe(LANDMARK.foreheadTop);
    expect(REGION_RINGS.faceOval).toContain(LANDMARK.chin);
    // Both eyelids are 9-point chains sharing the two corners.
    expect(REGION_RINGS.rightEye).toHaveLength(16);
    expect(REGION_RINGS.rightEye).toContain(LANDMARK.rightEyeOuter);
    expect(REGION_RINGS.rightEye).toContain(LANDMARK.rightEyeInner);
    expect(REGION_RINGS.leftEye).toContain(LANDMARK.leftEyeOuter);
    expect(REGION_RINGS.leftEye).toContain(LANDMARK.leftEyeInner);
    // Brows are two disjoint 5-point chains.
    expect(REGION_RINGS.rightBrow).toHaveLength(10);
    expect(REGION_RINGS.leftBrow).toHaveLength(10);
    expect(REGION_RINGS.lipsOuter).toContain(LANDMARK.rightMouthCorner);
    expect(REGION_RINGS.lipsOuter).toContain(LANDMARK.leftMouthCorner);
    expect(REGION_RINGS.mouthInner).toHaveLength(20);
    expect(REGION_RINGS.rightIris).toHaveLength(4);
  });

  it('splits the face oval into two jaw contours ending next to the chin', () => {
    expect(JAW_INDICES.right[0]).toBe(LANDMARK.rightCheekTop);
    expect(JAW_INDICES.left[0]).toBe(LANDMARK.leftCheekTop);
    expect(JAW_INDICES.right).toHaveLength(JAW_INDICES.left.length);
    expect(JAW_INDICES.right).not.toContain(LANDMARK.chin);
    expect(JAW_INDICES.left).not.toContain(LANDMARK.chin);
    expect(JAW_INDICES.right.length).toBeGreaterThan(6);
  });
});

describe.each(FIXTURES)('regions on $name', ({ analysis }) => {
  const { imageWidth: W, imageHeight: H } = analysis;
  const face = analysis.faces[0]!;

  it.each(REGIONS)('%s is a simple, closed polygon with positive area', (region) => {
    const poly = regionPolygon(face, region, W, H);
    expect(poly.length).toBe(REGION_RINGS[region].length);
    expect(Math.abs(signedArea(poly))).toBeGreaterThan(4);
    expect(isSimple(poly)).toBe(true);
    // Closed: the edge back to the start is no longer than the longest regular edge.
    const edges = edgeLengths(poly);
    const closing = edges[edges.length - 1]!;
    expect(closing).toBeLessThanOrEqual(Math.max(...edges.slice(0, -1)) * 1.5);
  });

  it('nests inner features inside their outer regions', () => {
    const oval = regionPolygon(face, 'faceOval', W, H);
    const lips = regionPolygon(face, 'lipsOuter', W, H);
    for (const region of ['rightEye', 'leftEye', 'rightBrow', 'leftBrow', 'lipsOuter', 'nose'] as const) {
      for (const p of regionPolygon(face, region, W, H)) expect(contains(oval, p)).toBe(true);
    }
    for (const p of regionPolygon(face, 'mouthInner', W, H)) {
      // Inner-lip points may touch the outer contour at the corners.
      const onCorner = [LANDMARK.rightMouthCorner, LANDMARK.leftMouthCorner].some((i) => {
        const c = { x: face.landmarks[i]!.x * W, y: face.landmarks[i]!.y * H };
        return Math.hypot(c.x - p.x, c.y - p.y) < 4;
      });
      expect(onCorner || contains(lips, p)).toBe(true);
    }
    for (const side of ['right', 'left'] as const) {
      const nostril = regionPolygon(face, `${side}Nostril`, W, H);
      const nose = regionPolygon(face, 'nose', W, H);
      for (const p of nostril) expect(contains(nose, p)).toBe(true);
    }
  });

  it('places eye centres inside their eye boxes and polygons', () => {
    const g = faceGeometry(face, W, H);
    for (const [eye, region] of [
      [g.rightEye, 'rightEye'],
      [g.leftEye, 'leftEye'],
    ] as const) {
      const poly = regionPolygon(face, region, W, H);
      const xs = poly.map((p) => p.x);
      const ys = poly.map((p) => p.y);
      expect(eye.center.x).toBeGreaterThan(Math.min(...xs));
      expect(eye.center.x).toBeLessThan(Math.max(...xs));
      expect(eye.center.y).toBeGreaterThan(Math.min(...ys));
      expect(eye.center.y).toBeLessThan(Math.max(...ys));
      expect(contains(poly, eye.center)).toBe(true);
      expect(eye.width).toBeGreaterThan(eye.height);
      expect(eye.radius).toBeCloseTo(eye.width / 2);
    }
  });

  it('orders the subject’s right side on the image left of an unmirrored portrait', () => {
    const g = faceGeometry(face, W, H);
    expect(g.rightEye.center.x).toBeLessThan(g.noseTip.x);
    expect(g.leftEye.center.x).toBeGreaterThan(g.noseTip.x);
    expect(g.rightNoseWing.x).toBeLessThan(g.noseTip.x);
    expect(g.leftNoseWing.x).toBeGreaterThan(g.noseTip.x);
    for (const p of g.rightJaw) expect(p.x).toBeLessThan(g.chin.x);
    for (const p of g.leftJaw) expect(p.x).toBeGreaterThan(g.chin.x);
    // Jaw contours run downwards towards the chin.
    for (const jaw of [g.rightJaw, g.leftJaw]) {
      expect(jaw[jaw.length - 1]!.y).toBeGreaterThan(jaw[0]!.y);
    }
  });

  it('derives an upright face frame', () => {
    const g = faceGeometry(face, W, H);
    expect(Math.hypot(g.up.x, g.up.y)).toBeCloseTo(1, 6);
    expect(g.up.y).toBeLessThan(-0.95);
    expect(g.up.x * g.across.x + g.up.y * g.across.y).toBeCloseTo(0, 6);
    expect(g.across.x).toBeGreaterThan(0.95);
    expect(g.chin.y).toBeGreaterThan(g.mouth.center.y);
    expect(g.mouth.center.y).toBeGreaterThan(g.noseTip.y);
    expect(g.noseTip.y).toBeGreaterThan(g.rightEye.center.y);
    // Typical frontal proportions.
    expect(g.interOcular / g.faceWidth).toBeGreaterThan(0.3);
    expect(g.interOcular / g.faceWidth).toBeLessThan(0.6);
    expect(g.faceHeight / g.faceWidth).toBeGreaterThan(0.8);
    expect(g.faceHeight / g.faceWidth).toBeLessThan(1.6);
    expect(g.mouth.width).toBeGreaterThan(g.rightEye.width);
  });

  it('measures lengths in aspect-correct pixels and scales with the frame', () => {
    const g = faceGeometry(face, W, H);
    const r = face.landmarks[LANDMARK.rightCheekTop]!;
    const l = face.landmarks[LANDMARK.leftCheekTop]!;
    expect(g.faceWidth).toBeCloseTo(Math.hypot((l.x - r.x) * W, (l.y - r.y) * H), 6);
    const half = faceGeometry(face, W / 2, H / 2);
    expect(half.faceWidth).toBeCloseTo(g.faceWidth / 2, 6);
    expect(half.interOcular).toBeCloseTo(g.interOcular / 2, 6);
    expect(half.center.x).toBeCloseTo(g.center.x / 2, 6);
    expect(half.up.x).toBeCloseTo(g.up.x, 6);
    // A squashed frame changes directions: geometry must not assume square pixels.
    const squashed = faceGeometry(face, W, H / 2);
    expect(squashed.faceHeight).toBeLessThan(g.faceHeight * 0.6);
  });
});
