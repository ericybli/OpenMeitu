import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GpuTexture, RenderTarget } from '../../src/engine/gl/gpu';
import type { PassEnv } from '../../src/engine/gl/pass';
import { faceReshapePass } from '../../src/engine/gl/passes/faceReshape';
import type { FaceReshapeParams, Layer } from '../../src/engine/types';
import { faceGeometry, type Vec2 } from '../../src/face/regions';
import { MAX_FACES, type Face, type FaceAnalysis } from '../../src/face/types';
import {
  buildWarpControls,
  MAX_LIPSCHITZ,
  MAX_WARP_CONTROLS,
  packWarpControls,
  WARP_SHIFT_VECTORS,
  warpLipschitzBound,
  warpSource,
  type WarpControl,
} from '../../src/face/warp';

function loadFixture(name: string): FaceAnalysis {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.faces.json`, import.meta.url), 'utf8')) as FaceAnalysis;
}

const NONE: FaceReshapeParams = { slim: 0, eyes: 0, nose: 0, chin: 0 };
const MAX: FaceReshapeParams = { slim: 1, eyes: 1, nose: 1, chin: 1 };

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function len(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

/** Jacobian determinant of the inverse map by central differences. */
function jacobianDet(controls: readonly WarpControl[], x: number, y: number, h = 0.5): number {
  const px = warpSource(controls, x + h, y);
  const mx = warpSource(controls, x - h, y);
  const py = warpSource(controls, x, y + h);
  const my = warpSource(controls, x, y - h);
  const a = (px.x - mx.x) / (2 * h);
  const b = (py.x - my.x) / (2 * h);
  const c = (px.y - mx.y) / (2 * h);
  const d = (py.y - my.y) / (2 * h);
  return a * d - b * c;
}

/** Grid over the face box, expanded by half its size, with `step` px spacing. */
function* faceGrid(face: Face, W: number, H: number, step: number): Generator<Vec2> {
  const { x, y, width, height } = face.box;
  const x0 = (x - width / 2) * W;
  const x1 = (x + width * 1.5) * W;
  const y0 = (y - height / 2) * H;
  const y1 = (y + height * 1.5) * H;
  for (let py = y0; py <= y1; py += step) for (let px = x0; px <= x1; px += step) yield { x: px, y: py };
}

function scaledFace(face: Face, s: number, dx: number, dy: number): Face {
  const landmarks = face.landmarks.map((p) => ({ x: p.x * s + dx, y: p.y * s + dy }));
  const { box } = face;
  return { landmarks, box: { x: box.x * s + dx, y: box.y * s + dy, width: box.width * s, height: box.height * s } };
}

describe.each(['portrait-a', 'portrait-b'])('face warp on %s', (name) => {
  const analysis = loadFixture(name);
  const { imageWidth: W, imageHeight: H } = analysis;
  const face = analysis.faces[0]!;
  const g = faceGeometry(face, W, H);

  it('is the identity for zero parameters', () => {
    expect(buildWarpControls(analysis.faces, NONE, W, H)).toEqual([]);
    for (const p of faceGrid(face, W, H, 17)) expect(warpSource([], p.x, p.y)).toEqual(p);
  });

  it('leaves pixels outside every control radius exactly in place', () => {
    const controls = buildWarpControls(analysis.faces, MAX, W, H);
    expect(controls.length).toBeGreaterThan(0);
    for (const p of [
      { x: 0.5, y: 0.5 },
      { x: W - 0.5, y: H - 0.5 },
      { x: W - 0.5, y: 0.5 },
      { x: 0.5, y: H - 0.5 },
    ]) {
      expect(warpSource(controls, p.x, p.y)).toEqual(p);
    }
    // The nose tip is outside the slim, eye and chin regions.
    const slimOnly = buildWarpControls(analysis.faces, { ...NONE, slim: 1, eyes: 1, chin: 1 }, W, H);
    expect(warpSource(slimOnly, g.noseTip.x, g.noseTip.y)).toEqual(g.noseTip);
  });

  it('enlarges the eyes: output pixels sample from closer to the eye centre', () => {
    const controls = buildWarpControls(analysis.faces, { ...NONE, eyes: 1 }, W, H);
    for (const eye of [g.rightEye, g.leftEye]) {
      for (const angle of [0, 1, 2, 3, 4, 5]) {
        const p = { x: eye.center.x + Math.cos(angle) * eye.radius * 0.6, y: eye.center.y + Math.sin(angle) * eye.radius * 0.6 };
        const src = warpSource(controls, p.x, p.y);
        expect(len(sub(src, eye.center))).toBeLessThan(len(sub(p, eye.center)) * 0.92);
      }
      // The centre itself stays put.
      const c = warpSource(controls, eye.center.x, eye.center.y);
      expect(len(sub(c, eye.center))).toBeLessThan(1e-9);
    }
  });

  it('slims the jaw: content moves towards the face axis', () => {
    const controls = buildWarpControls(analysis.faces, { ...NONE, slim: 1 }, W, H);
    for (const [jaw, inward] of [
      [g.rightJaw, g.across],
      [g.leftJaw, { x: -g.across.x, y: -g.across.y }],
    ] as const) {
      const mid = jaw[Math.floor(jaw.length / 2)]!;
      const src = warpSource(controls, mid.x, mid.y);
      // The output pixel on the old contour now shows what was further out.
      expect(dot(sub(src, mid), inward)).toBeLessThan(-g.faceWidth * 0.01);
    }
  });

  it('narrows the nose wings towards the midline', () => {
    const controls = buildWarpControls(analysis.faces, { ...NONE, nose: 1 }, W, H);
    for (const [wing, inward] of [
      [g.rightNoseWing, g.across],
      [g.leftNoseWing, { x: -g.across.x, y: -g.across.y }],
    ] as const) {
      const src = warpSource(controls, wing.x, wing.y);
      expect(dot(sub(src, wing), inward)).toBeLessThan(-1);
    }
  });

  it('moves the chin along the face axis: positive lengthens, negative shortens', () => {
    for (const chin of [1, -1]) {
      const controls = buildWarpControls(analysis.faces, { ...NONE, chin }, W, H);
      expect(controls).toHaveLength(1);
      const t = { x: controls[0]!.tx, y: controls[0]!.ty };
      // Positive chin pushes the chin away from the forehead.
      expect(Math.sign(dot(t, g.up))).toBe(-chin);
      // Content at the chin lands about one translation further along.
      const landed = warpSource(controls, g.chin.x + t.x, g.chin.y + t.y);
      expect(len(sub(landed, g.chin))).toBeLessThan(len(t) * 0.25);
      // The lower lip barely moves.
      const lip = warpSource(controls, g.mouth.bottom.x, g.mouth.bottom.y);
      expect(len(sub(lip, g.mouth.bottom))).toBeLessThan(len(t) * 0.1);
    }
  });

  it('is continuous with a bounded displacement gradient', () => {
    const controls = buildWarpControls(analysis.faces, MAX, W, H);
    const h = 0.25;
    for (const p of faceGrid(face, W, H, 3)) {
      const d0 = sub(warpSource(controls, p.x, p.y), p);
      for (const q of [
        { x: p.x + h, y: p.y },
        { x: p.x, y: p.y + h },
      ]) {
        const d1 = sub(warpSource(controls, q.x, q.y), q);
        expect(len(sub(d1, d0)) / h).toBeLessThanOrEqual(MAX_LIPSCHITZ + 1e-6);
      }
    }
  });

  it.each([
    ['max parameters', MAX],
    ['negative chin', { ...MAX, chin: -1 }],
    ['parameters far beyond the UI range', { slim: 6, eyes: 4, nose: 8, chin: -7 }],
  ])('never folds (positive Jacobian on a dense grid) with %s', (_label, params) => {
    const controls = buildWarpControls(analysis.faces, params, W, H);
    let minDet = Infinity;
    for (const p of faceGrid(face, W, H, 1.5)) minDet = Math.min(minDet, jacobianDet(controls, p.x, p.y));
    expect(minDet).toBeGreaterThan(0);
    expect(minDet).toBeGreaterThanOrEqual((1 - MAX_LIPSCHITZ) ** 2 - 1e-3);
  });

  it('keeps the warp within the Lipschitz budget for any parameters', () => {
    const controls = buildWarpControls(analysis.faces, { slim: 6, eyes: 4, nose: 8, chin: -7 }, W, H);
    expect(warpLipschitzBound(controls)).toBeLessThanOrEqual(MAX_LIPSCHITZ + 1e-9);
  });

  it('bounds the measured displacement gradient from above', () => {
    for (const params of [MAX, { ...MAX, chin: -1 }, { slim: 6, eyes: 4, nose: 8, chin: -7 }]) {
      const controls = buildWarpControls(analysis.faces, params, W, H);
      const bound = warpLipschitzBound(controls);
      const h = 0.25;
      let measured = 0;
      for (const p of faceGrid(face, W, H, 2)) {
        const d0 = sub(warpSource(controls, p.x, p.y), p);
        for (const q of [
          { x: p.x + h, y: p.y },
          { x: p.x, y: p.y + h },
          { x: p.x + h * Math.SQRT1_2, y: p.y - h * Math.SQRT1_2 },
        ]) {
          measured = Math.max(measured, len(sub(sub(warpSource(controls, q.x, q.y), q), d0)) / h);
        }
      }
      expect(measured).toBeLessThanOrEqual(bound + 1e-6);
      expect(measured).toBeGreaterThan(bound * 0.3);
    }
  });

  it('does not need the folding guard anywhere in the UI range, so sliders respond linearly', () => {
    for (const chin of [-1, 1]) {
      const full = buildWarpControls(analysis.faces, { ...MAX, chin }, W, H);
      const half = buildWarpControls(analysis.faces, { slim: 0.5, eyes: 0.5, nose: 0.5, chin: chin / 2 }, W, H);
      expect(full).toHaveLength(half.length);
      full.forEach((c, i) => {
        const h = half[i]!;
        expect([c.x, c.y, c.radius]).toEqual([h.x, h.y, h.radius]);
        expect(c.tx).toBeCloseTo(2 * h.tx, 9);
        expect(c.ty).toBeCloseTo(2 * h.ty, 9);
        expect(c.scale).toBeCloseTo(2 * h.scale, 9);
      });
    }
    // Far beyond the UI range the guard does scale the controls down.
    const guarded = buildWarpControls(analysis.faces, { ...MAX, slim: 6 }, W, H);
    const unguarded = buildWarpControls(analysis.faces, { ...NONE, slim: 1 }, W, H);
    expect(Math.hypot(guarded[0]!.tx, guarded[0]!.ty)).toBeLessThan(Math.hypot(unguarded[0]!.tx, unguarded[0]!.ty) * 6 * 0.99);
  });

  it('rotates with the face', () => {
    // Place the face in a square frame, then rotate the landmarks about its centre.
    const S = 1200;
    const place = (angle: number): Face => {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const landmarks = face.landmarks.map((p) => {
        const x = p.x * W - W / 2;
        const y = p.y * H - H / 2;
        return { x: (x * cos - y * sin + S / 2) / S, y: (x * sin + y * cos + S / 2) / S };
      });
      return { landmarks, box: face.box };
    };
    for (const angle of [0.6, Math.PI / 2, -2.5]) {
      const upright = buildWarpControls([place(0)], MAX, S, S);
      const rotated = buildWarpControls([place(angle)], MAX, S, S);
      const rot = (p: Vec2): Vec2 => {
        const x = p.x - S / 2;
        const y = p.y - S / 2;
        return { x: x * Math.cos(angle) - y * Math.sin(angle) + S / 2, y: x * Math.sin(angle) + y * Math.cos(angle) + S / 2 };
      };
      let moved = 0;
      for (let y = 200; y <= 1000; y += 9) {
        for (let x = 200; x <= 1000; x += 9) {
          const p = { x, y };
          const expected = rot(warpSource(upright, p.x, p.y));
          const actual = warpSource(rotated, rot(p).x, rot(p).y);
          expect(Math.abs(actual.x - expected.x)).toBeLessThan(1e-6);
          expect(Math.abs(actual.y - expected.y)).toBeLessThan(1e-6);
          if (len(sub(warpSource(upright, x, y), p)) > 0.5) moved++;
        }
      }
      expect(moved).toBeGreaterThan(300);
    }
  });

  it('measures in pixels, whatever the frame aspect ratio', () => {
    // The same face in a wider frame: normalised x changes, pixel geometry does not.
    const wide = 2 * W;
    const shift = W / 2;
    const widened: Face = { landmarks: face.landmarks.map((p) => ({ x: (p.x * W + shift) / wide, y: p.y })), box: face.box };
    const a = buildWarpControls([face], MAX, W, H);
    const b = buildWarpControls([widened], MAX, wide, H);
    for (const p of faceGrid(face, W, H, 13)) {
      const sa = warpSource(a, p.x, p.y);
      const sb = warpSource(b, p.x + shift, p.y);
      expect(Math.abs(sb.x - shift - sa.x)).toBeLessThan(1e-6);
      expect(Math.abs(sb.y - sa.y)).toBeLessThan(1e-6);
    }
  });

  it('is resolution independent', () => {
    const full = buildWarpControls(analysis.faces, MAX, W, H);
    const half = buildWarpControls(analysis.faces, MAX, W / 2, H / 2);
    for (const p of faceGrid(face, W, H, 23)) {
      const a = warpSource(full, p.x, p.y);
      const b = warpSource(half, p.x / 2, p.y / 2);
      expect(Math.abs(a.x - b.x * 2)).toBeLessThan(1e-6);
      expect(Math.abs(a.y - b.y * 2)).toBeLessThan(1e-6);
    }
  });
});

describe('multiple faces', () => {
  const analysis = loadFixture('portrait-b');
  const { imageWidth: W, imageHeight: H } = analysis;
  const face = analysis.faces[0]!;

  it('warps each face, largest first, and skips tiny faces', () => {
    const big = scaledFace(face, 0.45, 0, 0.5);
    const small = scaledFace(face, 0.4, 0.55, 0.55);
    const tiny = scaledFace(face, 0.02, 0.9, 0.05);
    const single = buildWarpControls([big], MAX, W, H);
    const controls = buildWarpControls([small, tiny, big], MAX, W, H);
    expect(controls).toHaveLength(single.length * 2);
    // Largest face first.
    expect(controls.slice(0, single.length)).toEqual(single);
    const tinyBox = tiny.box;
    for (const c of controls) {
      const insideTiny = c.x >= tinyBox.x * W - 5 && c.x <= (tinyBox.x + tinyBox.width) * W + 5 && c.y <= (tinyBox.y + tinyBox.height) * H + 5;
      expect(insideTiny).toBe(false);
    }
  });

  it(`reshapes every face, and the largest ${MAX_FACES} of more`, () => {
    // Smallest first, so the input order cannot decide which faces are kept.
    const faces = Array.from({ length: MAX_FACES + 2 }, (_, i) => scaledFace(face, 0.15 + i * 0.005, (i % 5) * 0.2, Math.floor(i / 5) * 0.5));
    const controls = buildWarpControls(faces, MAX, W, H);
    const perFace = buildWarpControls([faces[0]!], MAX, W, H).length;
    expect(controls).toHaveLength(perFace * MAX_FACES);
    expect(controls.length).toBeLessThanOrEqual(MAX_WARP_CONTROLS);
    const on = (f: Face) => controls.filter((c) => c.x >= f.box.x * W && c.x <= (f.box.x + f.box.width) * W && c.y >= f.box.y * H && c.y <= (f.box.y + f.box.height) * H);
    for (const skipped of faces.slice(0, 2)) expect(on(skipped)).toHaveLength(0);
    for (const kept of faces.slice(2)) expect(on(kept)).toHaveLength(perFace);
  });

  it('packs controls into the uniform arrays', () => {
    const controls = buildWarpControls([face], MAX, W, H);
    const packed = packWarpControls(controls);
    expect(packed.count).toBe(controls.length);
    expect(packed.shape).toHaveLength(MAX_WARP_CONTROLS * 4);
    expect(packed.shift).toHaveLength(WARP_SHIFT_VECTORS * 4);
    for (const [i, c] of controls.entries()) {
      expect(Array.from(packed.shape.slice(i * 4, i * 4 + 4))).toEqual(Array.from(new Float32Array([c.x, c.y, c.radius, c.scale])));
      expect(Array.from(packed.shift.slice(i * 2, i * 2 + 2))).toEqual(Array.from(new Float32Array([c.tx, c.ty])));
    }
  });
});

describe('face-reshape shader', () => {
  /** MAX_FRAGMENT_UNIFORM_VECTORS is at least this on every WebGL2 implementation. */
  const WEBGL2_FRAGMENT_UNIFORM_VECTORS = 224;
  const COMPONENTS: Record<string, number> = { float: 1, int: 1, vec2: 2, vec3: 3, vec4: 4 };

  /** Uniform declarations of `source`, with #define'd array sizes resolved. */
  function uniforms(source: string): { name: string; type: string; count: number }[] {
    const defines = new Map([...source.matchAll(/#define\s+(\w+)\s+(\d+)/g)].map((m) => [m[1]!, Number(m[2])]));
    return [...source.matchAll(/uniform\s+(\w+)\s+(\w+)\s*(?:\[\s*(\w+)\s*\])?\s*;/g)].map(([, type, name, size]) => ({
      type: type!,
      name: name!,
      count: size === undefined ? 1 : (defines.get(size) ?? Number(size)),
    }));
  }

  it(`reshapes ${MAX_FACES} faces within the fragment uniform vectors WebGL2 guarantees`, () => {
    const analysis = loadFixture('portrait-b');
    const { imageWidth: W, imageHeight: H } = analysis;
    const faces = Array.from({ length: MAX_FACES }, (_, i) => scaledFace(analysis.faces[0]!, 0.18, (i % 4) * 0.25, Math.floor(i / 4) * 0.5));
    let source = '';
    let values: Record<string, unknown> = {};
    const gpu = {
      program: (_key: string, fragment: string) => ((source = fragment), {}),
      draw: (_program: unknown, _target: unknown, uniformValues: Record<string, unknown>) => {
        values = uniformValues;
      },
    };
    const env = { gpu, width: W, height: H, scale: 1, sourceDiagonal: Math.hypot(W, H), face: { imageWidth: W, imageHeight: H, faces } } as unknown as PassEnv;
    const layer: Layer<'faceReshape'> = { id: 'reshape', kind: 'faceReshape', enabled: true, opacity: 1, params: MAX };
    faceReshapePass.run(env, {} as GpuTexture, {} as RenderTarget, layer);

    expect(values.u_count).toBe(buildWarpControls([faces[0]!], MAX, W, H).length * MAX_FACES);
    const declared = uniforms(source);
    // Conservatively, every scalar, vector and sampler takes a whole vector.
    expect(declared.reduce((sum, u) => sum + u.count, 0)).toBeLessThanOrEqual(WEBGL2_FRAGMENT_UNIFORM_VECTORS);
    for (const u of declared.filter((d) => d.count > 1)) expect(values[u.name]).toHaveLength(u.count * COMPONENTS[u.type]!);
  });
});
