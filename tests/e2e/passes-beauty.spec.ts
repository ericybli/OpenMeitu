import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_PARAMS, type AnyLayer, type Layer, type LayerKind, type LayerParams } from '../../src/engine/types';
import { MAX_FACES, type FaceAnalysis } from '../../src/face/types';
import { buildWarpControls, warpSource } from '../../src/face/warp';
import { makeImage, meanAbsDiff, openHarness, render, type Pixels } from './harness';

const OUT_DIR = 'test-results/beauty';
const PORTRAITS = ['portrait-a', 'portrait-b'] as const;
type Portrait = (typeof PORTRAITS)[number];

function analysisOf(name: Portrait): FaceAnalysis {
  return JSON.parse(readFileSync(`tests/fixtures/${name}.faces.json`, 'utf8')) as FaceAnalysis;
}

function layer<K extends LayerKind>(kind: K, params: Partial<LayerParams[K]>): Layer<K> {
  return { id: kind, kind, enabled: true, opacity: 1, params: { ...DEFAULT_PARAMS[kind], ...params } };
}

const STRONG: Record<string, AnyLayer[]> = {
  smooth: [layer('skinSmooth', { amount: 1 })],
  whiten: [layer('skinWhiten', { amount: 1 })],
  teeth: [layer('teethWhiten', { amount: 1 })],
  eyes: [layer('faceReshape', { eyes: 1 })],
  slim: [layer('faceReshape', { slim: 1 })],
  nose: [layer('faceReshape', { nose: 1 })],
  chinLonger: [layer('faceReshape', { chin: 1 })],
  chinShorter: [layer('faceReshape', { chin: -1 })],
};

const NATURAL: AnyLayer[] = [
  layer('skinSmooth', { amount: 0.55, detail: 0.35 }),
  layer('skinWhiten', { amount: 0.35 }),
  layer('teethWhiten', { amount: 0.5 }),
  layer('faceReshape', { slim: 0.35, eyes: 0.3, nose: 0.25, chin: 0.1 }),
];

async function renderPortrait(page: Page, name: Portrait, layers: AnyLayer[], analysis: FaceAnalysis | null = analysisOf(name)): Promise<Pixels> {
  return render(page, { image: { url: `/tests/fixtures/${name}.jpg` }, layers, analysis });
}

// ------------------------------------------------------------------ measurements

function luma(p: Pixels, x: number, y: number): number {
  const i = (y * p.width + x) * 4;
  return 0.2126 * p.data[i]! + 0.7152 * p.data[i + 1]! + 0.0722 * p.data[i + 2]!;
}

interface Patch {
  x: number;
  y: number;
  half: number;
}

function patchAt(analysis: FaceAnalysis, landmark: number, half: number): Patch {
  const p = analysis.faces[0]!.landmarks[landmark]!;
  return { x: Math.round(p.x * analysis.imageWidth), y: Math.round(p.y * analysis.imageHeight), half };
}

function patchMid(analysis: FaceAnalysis, a: number, b: number, half: number): Patch {
  const pa = patchAt(analysis, a, half);
  const pb = patchAt(analysis, b, half);
  return { x: Math.round((pa.x + pb.x) / 2), y: Math.round((pa.y + pb.y) / 2), half };
}

function crop(p: Pixels, { x, y, half }: Patch): Pixels {
  const w = half * 2 + 1;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let j = 0; j < w; j++) {
    const row = ((y - half + j) * p.width + (x - half)) * 4;
    data.set(p.data.subarray(row, row + w * 4), j * w * 4);
  }
  return { width: w, height: w, data };
}

function meanLumaIn(p: Pixels, { x, y, half }: Patch): number {
  let s = 0;
  let n = 0;
  for (let j = y - half; j <= y + half; j++) for (let i = x - half; i <= x + half; i++, n++) s += luma(p, i, j);
  return s / n;
}

/** Variance of luma minus its 5x5 local mean: the fine/mid-frequency texture energy. */
function detailEnergy(p: Pixels, { x, y, half }: Patch): number {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let j = y - half; j <= y + half; j++) {
    for (let i = x - half; i <= x + half; i++) {
      let m = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) m += luma(p, i + di, j + dj);
      const d = luma(p, i, j) - m / 25;
      s += d;
      s2 += d * d;
      n++;
    }
  }
  return s2 / n - (s / n) ** 2;
}

function patchDiff(a: Pixels, b: Pixels, patch: Patch): number {
  return meanAbsDiff(crop(a, patch), crop(b, patch));
}

/** Mean yellowness (0.5 - Cb, in 0..255 units) over bright, low-chroma pixels of the original inside `patch`. */
function teethYellowness(original: Pixels, p: Pixels, { x, y, half }: Patch, halfHeight: number): { yellow: number; count: number } {
  let sum = 0;
  let count = 0;
  for (let j = y - halfHeight; j <= y + halfHeight; j++) {
    for (let i = x - half; i <= x + half; i++) {
      const k = (j * p.width + i) * 4;
      const [r0, g0, b0] = [original.data[k]!, original.data[k + 1]!, original.data[k + 2]!];
      const y0 = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
      const cr0 = 0.5 * r0 - 0.418688 * g0 - 0.081312 * b0;
      if (y0 < 150 || cr0 > 12) continue;
      const cb = -0.168736 * p.data[k]! - 0.331264 * p.data[k + 1]! + 0.5 * p.data[k + 2]!;
      sum += -cb;
      count++;
    }
  }
  return { yellow: count ? sum / count : 0, count };
}

// ------------------------------------------------------------------ visual review output

async function writeComparison(page: Page, file: string, before: Pixels, after: Pixels, faceBox?: FaceAnalysis['faces'][number]['box']): Promise<void> {
  const toB64 = (p: Pixels) => Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength).toString('base64');
  const dataUrl = await page.evaluate(
    async ({ width, height, a, b, box }) => {
      const decode = (s: string) => {
        const bin = atob(s);
        const bytes = new Uint8ClampedArray(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new ImageData(bytes, width, height);
      };
      const bitmaps = await Promise.all([a, b].map((s) => createImageBitmap(decode(s))));
      // Full frame, or a 2x crop around the face for close inspection.
      const sx = box ? Math.max(0, Math.round((box.x - box.width * 0.08) * width)) : 0;
      const sy = box ? Math.max(0, Math.round((box.y - box.height * 0.12) * height)) : 0;
      const sw = box ? Math.min(width - sx, Math.round(box.width * 1.16 * width)) : width;
      const sh = box ? Math.min(height - sy, Math.round(box.height * 1.22 * height)) : height;
      const zoom = box ? 2 : 1;
      const canvas = document.createElement('canvas');
      canvas.width = sw * zoom * 2 + 4;
      canvas.height = sh * zoom;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      bitmaps.forEach((bmp, i) => ctx.drawImage(bmp, sx, sy, sw, sh, i * (sw * zoom + 4), 0, sw * zoom, sh * zoom));
      return canvas.toDataURL('image/png');
    },
    { width: before.width, height: before.height, a: toB64(before), b: toB64(after), box: faceBox ?? null },
  );
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/${file}`, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

// ------------------------------------------------------------------ tests

test.describe('beauty passes on portrait-a', () => {
  const name: Portrait = 'portrait-a';
  const analysis = analysisOf(name);
  const cheeks = [patchAt(analysis, 50, 7), patchAt(analysis, 280, 7)];
  const eyes = [patchAt(analysis, 468, 5), patchAt(analysis, 473, 5)];
  const brows = [patchAt(analysis, 105, 4), patchAt(analysis, 334, 4)];
  const lip = patchMid(analysis, 14, 17, 4);
  const noseTip = patchAt(analysis, 4, 4);
  const sky: Patch[] = [
    { x: 560, y: 120, half: 12 },
    { x: 520, y: 330, half: 12 },
  ];
  // Flag, uniform badge and shoulder patch: saturated reds and whites near skin hues.
  const background: Patch[] = [...sky, { x: 40, y: 40, half: 12 }, { x: 100, y: 420, half: 12 }, { x: 600, y: 750, half: 12 }, { x: 430, y: 785, half: 8 }];

  let original: Pixels;
  test.beforeEach(async ({ page }) => {
    await openHarness(page);
    original ??= await renderPortrait(page, name, []);
  });

  test('amount 0 leaves the image untouched', async ({ page }) => {
    const zero = await renderPortrait(page, name, [
      layer('skinSmooth', { amount: 0 }),
      layer('skinWhiten', { amount: 0 }),
      layer('teethWhiten', { amount: 0 }),
      layer('faceReshape', {}),
    ]);
    expect(meanAbsDiff(zero, original)).toBe(0);
  });

  test('skin smoothing removes skin texture but keeps features and background sharp', async ({ page }) => {
    const out = await renderPortrait(page, name, STRONG.smooth!);
    for (const cheek of cheeks) {
      expect(detailEnergy(out, cheek)).toBeLessThan(detailEnergy(original, cheek) * 0.55);
    }
    for (const patch of [...eyes, ...brows, lip]) {
      expect(detailEnergy(out, patch)).toBeGreaterThan(detailEnergy(original, patch) * 0.8);
      expect(patchDiff(out, original, patch)).toBeLessThan(3);
    }
    for (const patch of background) expect(patchDiff(out, original, patch)).toBeLessThan(0.5);
  });

  test('skin smoothing without a face falls back to a gentle colour-only mask', async ({ page }) => {
    const out = await renderPortrait(page, name, STRONG.smooth!, null);
    const withFace = await renderPortrait(page, name, STRONG.smooth!);
    const before = detailEnergy(original, cheeks[0]!);
    expect(detailEnergy(out, cheeks[0]!)).toBeLessThan(before * 0.85);
    expect(detailEnergy(out, cheeks[0]!)).toBeGreaterThan(detailEnergy(withFace, cheeks[0]!));
    for (const patch of sky) expect(patchDiff(out, original, patch)).toBeLessThan(0.5);
  });

  test('whitening brightens skin, not the background', async ({ page }) => {
    const out = await renderPortrait(page, name, STRONG.whiten!);
    for (const cheek of cheeks) expect(meanLumaIn(out, cheek) - meanLumaIn(original, cheek)).toBeGreaterThan(8);
    for (const patch of background) expect(patchDiff(out, original, patch)).toBeLessThan(0.5);
    for (const patch of eyes) expect(meanLumaIn(out, patch) - meanLumaIn(original, patch)).toBeLessThan(4);
  });

  test('whitening reaches the skin right below the eyes, leaving no darker rings', async ({ page }) => {
    const out = await renderPortrait(page, name, STRONG.whiten!);
    const face = analysis.faces[0]!;
    const px = (i: number) => ({ x: face.landmarks[i]!.x * analysis.imageWidth, y: face.landmarks[i]!.y * analysis.imageHeight });
    for (const [outer, inner, lowerLid, cheek] of [
      [33, 133, 145, cheeks[0]!],
      [263, 362, 374, cheeks[1]!],
    ] as const) {
      const eyeWidth = Math.hypot(px(outer).x - px(inner).x, px(outer).y - px(inner).y);
      const underEye = { x: Math.round(px(lowerLid).x), y: Math.round(px(lowerLid).y + eyeWidth * 0.15), half: 3 };
      const cheekLift = meanLumaIn(out, cheek) - meanLumaIn(original, cheek);
      expect(meanLumaIn(out, underEye) - meanLumaIn(original, underEye)).toBeGreaterThan(cheekLift * 0.6);
    }
  });

  test("a neighbouring face's mask never reaches another face's eyes", async ({ page }) => {
    // A second face above this one, so its neck area covers this face's eyes.
    const face = analysis.faces[0]!;
    const shift = 0.32;
    const above = { landmarks: face.landmarks.map((p) => ({ x: p.x, y: p.y - shift })), box: { ...face.box, y: face.box.y - shift } };
    const crowded: FaceAnalysis = { ...analysis, faces: [face, above] };
    const single = await renderPortrait(page, name, [...STRONG.smooth!, ...STRONG.whiten!]);
    const out = await renderPortrait(page, name, [...STRONG.smooth!, ...STRONG.whiten!], crowded);
    for (const eye of eyes) {
      const patch = { ...eye, half: 9 };
      expect(patchDiff(out, single, patch)).toBeLessThan(0.5);
    }
    for (const patch of [...brows, lip]) expect(patchDiff(out, single, patch)).toBeLessThan(0.5);
  });

  test('teeth whitening reduces yellow inside the mouth only', async ({ page }) => {
    const out = await renderPortrait(page, name, STRONG.teeth!);
    const mouth = patchMid(analysis, 13, 14, 0);
    const mouthHalfWidth = Math.round(((analysis.faces[0]!.landmarks[291]!.x - analysis.faces[0]!.landmarks[61]!.x) * analysis.imageWidth) / 3);
    const teeth = { ...mouth, half: mouthHalfWidth };
    const before = teethYellowness(original, original, teeth, 4);
    const after = teethYellowness(original, out, teeth, 4);
    expect(before.count).toBeGreaterThan(50);
    expect(after.yellow).toBeLessThan(before.yellow - 3);
    for (const cheek of cheeks) expect(patchDiff(out, original, cheek)).toBe(0);
    expect(patchDiff(out, original, lip)).toBeLessThan(1);
  });

  test('eye enlargement moves pixels around the eyes only', async ({ page }) => {
    const out = await renderPortrait(page, name, STRONG.eyes!);
    for (const eye of eyes) expect(patchDiff(out, original, { ...eye, half: 12 })).toBeGreaterThan(4);
    for (const patch of [...background, noseTip, lip]) expect(patchDiff(out, original, patch)).toBe(0);
  });

  test('slimming moves the jaw line but not the nose tip', async ({ page }) => {
    const out = await renderPortrait(page, name, STRONG.slim!);
    for (const jaw of [patchAt(analysis, 172, 6), patchAt(analysis, 397, 6)]) {
      expect(patchDiff(out, original, jaw)).toBeGreaterThan(3);
    }
    for (const patch of [noseTip, ...eyes, ...background]) expect(patchDiff(out, original, patch)).toBe(0);
  });

  test('the GPU warp matches the CPU reference mapping', async ({ page }) => {
    const params = { slim: 1, eyes: 1, nose: 1, chin: 0.6 };
    const out = await renderPortrait(page, name, [layer('faceReshape', params)]);
    const controls = buildWarpControls(analysis.faces, params, original.width, original.height);
    // Bilinear sample of the original at a continuous pixel position (texel centres at +0.5).
    const sample = (x: number, y: number, ch: number) => {
      const fx = Math.min(original.width - 1, Math.max(0, x - 0.5));
      const fy = Math.min(original.height - 1, Math.max(0, y - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(original.width - 1, x0 + 1);
      const y1 = Math.min(original.height - 1, y0 + 1);
      const at = (px: number, py: number) => original.data[(py * original.width + px) * 4 + ch]!;
      const tx = fx - x0;
      const ty = fy - y0;
      return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
    };
    const { box } = analysis.faces[0]!;
    let worst = 0;
    let moved = 0;
    for (let y = Math.round(box.y * original.height); y < (box.y + box.height) * original.height; y += 3) {
      for (let x = Math.round(box.x * original.width); x < (box.x + box.width) * original.width; x += 3) {
        const src = warpSource(controls, x + 0.5, y + 0.5);
        if (Math.hypot(src.x - x - 0.5, src.y - y - 0.5) > 0.5) moved++;
        for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(out.data[(y * out.width + x) * 4 + ch]! - sample(src.x, src.y, ch)));
      }
    }
    expect(moved).toBeGreaterThan(500);
    expect(worst).toBeLessThan(3);
  });

  test('effects are resolution independent', async ({ page }) => {
    const layers = [...STRONG.smooth!, ...STRONG.whiten!];
    const half = await render(page, { image: { url: `/tests/fixtures/${name}.jpg` }, layers, analysis, maxSize: 400 });
    const halfOriginal = await render(page, { image: { url: `/tests/fixtures/${name}.jpg` }, layers: [], analysis, maxSize: 400 });
    const scaled = (p: Patch): Patch => ({ x: Math.round(p.x / 2), y: Math.round(p.y / 2), half: Math.max(3, Math.round(p.half / 2)) });
    const full = await renderPortrait(page, name, layers);
    for (const cheek of cheeks) {
      const fullLift = meanLumaIn(full, cheek) - meanLumaIn(original, cheek);
      const halfLift = meanLumaIn(half, scaled(cheek)) - meanLumaIn(halfOriginal, scaled(cheek));
      expect(Math.abs(fullLift - halfLift)).toBeLessThan(2.5);
    }
  });
});

/**
 * Preview skin smoothing on portrait-a at full size, as during slider drags:
 * `steps` run in order on one renderer, each compared with a renderer that
 * has cached nothing. A step with `failCoefficients` has the coefficient
 * computation throw. Returns, per step, the programs drawn (presenting
 * aside), whether it threw and whether its output matches the fresh one.
 */
async function smoothingDrag(page: Page, steps: { amount: number; detail: number; failCoefficients?: boolean }[]) {
  return page.evaluate(
    async ({ analysis, steps }) => {
      const h = window.omHarness;
      const bitmap = await h.loadImage({ url: '/tests/fixtures/portrait-a.jpg' });
      const size = { width: bitmap.width, height: bitmap.height };
      const layers = (amount: number, detail: number) => [{ id: 'smooth', kind: 'skinSmooth', enabled: true, opacity: 1, params: { amount, detail } } as const];
      const open = () => {
        const r = h.createRenderer();
        r.setSource(bitmap);
        r.setAnalysis(analysis);
        return r;
      };
      const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
      const dragged = open();
      const log = h.traceDraws(dragged);
      const program = dragged.gpu.program.bind(dragged.gpu);
      try {
        return steps.map(({ amount, detail, failCoefficients }) => {
          log.length = 0;
          dragged.gpu.program = (key, ...rest) => {
            if (failCoefficients && key === 'skinSmooth.stats') throw new Error('simulated GPU failure');
            return program(key, ...rest);
          };
          let threw = false;
          try {
            dragged.renderPreview(layers(amount, detail), size);
          } catch {
            threw = true;
          }
          const programs = log.map((d) => d.program).filter((p) => p !== 'gpu.present');
          if (threw) return { programs, threw, matchesFresh: false };
          const fresh = open();
          try {
            fresh.renderPreview(layers(amount, detail), size);
            return { programs, threw, matchesFresh: same(h.readCanvas(dragged), h.readCanvas(fresh)) };
          } finally {
            fresh.dispose();
          }
        });
      } finally {
        dragged.dispose();
        bitmap.close();
      }
    },
    { analysis: analysisOf('portrait-a'), steps },
  );
}

test('changing only the smoothing detail redraws just the composite, with identical output', async ({ page }) => {
  await openHarness(page);
  const [first, detail, amount] = await smoothingDrag(page, [
    { amount: 1, detail: 0.2 },
    { amount: 1, detail: 0.8 },
    { amount: 0.5, detail: 0.8 },
  ]);
  for (const step of [first, detail, amount]) expect(step!.matchesFresh).toBe(true);
  expect(first!.programs).toContain('skinSmooth.stats');
  expect(detail!.programs).toEqual([expect.stringMatching(/^skinSmooth\.composite\./)]);
  // The coefficients depend on the amount.
  expect(amount!.programs).toContain('skinSmooth.stats');
});

test('skin smoothing recovers from a failed render without reusing its partial results', async ({ page }) => {
  await openHarness(page);
  const [, failed, back] = await smoothingDrag(page, [
    { amount: 0.5, detail: 0.5 },
    { amount: 0.7, detail: 0.5, failCoefficients: true },
    { amount: 0.5, detail: 0.5 },
  ]);
  expect(failed!.threw).toBe(true);
  expect(back!.threw).toBe(false);
  expect(back!.matchesFresh).toBe(true);
});

test('neutral colours are never treated as skin', async ({ page }) => {
  await openHarness(page);
  // Exact greys from black to white, plus a skin-coloured control stripe.
  const image = makeImage(256, 64, (x, y) => (y < 48 ? [x, x, x] : [214, 160, 130]));
  const layers = [...STRONG.smooth!, ...STRONG.whiten!];
  const before = await render(page, { image, layers: [] });
  const after = await render(page, { image, layers });
  const greys = { data: before.data.subarray(0, 256 * 40 * 4) };
  expect(meanAbsDiff({ data: after.data.subarray(0, 256 * 40 * 4) }, greys)).toBe(0);
  const skin = (p: Pixels) => ({ data: p.data.subarray(256 * 56 * 4) });
  expect(meanAbsDiff(skin(after), skin(before))).toBeGreaterThan(5);
});

test('retouches several faces in one image independently', async ({ page }) => {
  await openHarness(page);
  // Both portraits side by side at half size, with their landmarks remapped.
  const halves = await Promise.all(PORTRAITS.map((name) => render(page, { image: { url: `/tests/fixtures/${name}.jpg` }, layers: [], maxSize: 400 })));
  const hw = halves[0]!.width;
  const h = halves[0]!.height;
  const data: number[] = new Array(hw * 2 * h * 4);
  halves.forEach((half, k) => {
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < hw * 4; i++) data[(y * hw * 2) * 4 + k * hw * 4 + i] = half.data[y * hw * 4 + i]!;
    }
  });
  const image = { width: hw * 2, height: h, data };
  const analysis: FaceAnalysis = {
    imageWidth: hw * 2,
    imageHeight: h,
    faces: PORTRAITS.map((name, k) => {
      const face = analysisOf(name).faces[0]!;
      return {
        landmarks: face.landmarks.map((p) => ({ x: p.x / 2 + k / 2, y: p.y })),
        box: { ...face.box, x: face.box.x / 2 + k / 2, width: face.box.width / 2 },
      };
    }),
  };
  const before = await render(page, { image, layers: [], analysis });
  const after = await render(page, { image, layers: NATURAL, analysis });
  for (const face of analysis.faces) {
    const cheek = face.landmarks[50]!;
    const patch = { x: Math.round(cheek.x * image.width), y: Math.round(cheek.y * h), half: 4 };
    expect(meanLumaIn(after, patch) - meanLumaIn(before, patch)).toBeGreaterThan(3);
    const eye = face.landmarks[468]!;
    expect(patchDiff(after, before, { x: Math.round(eye.x * image.width), y: Math.round(eye.y * h), half: 6 })).toBeGreaterThan(1);
  }
  expect(patchDiff(after, before, { x: hw, y: 40, half: 10 })).toBeLessThan(0.5);
  await writeComparison(page, 'two-faces-natural.png', before, after);
});

test(`retouches and reshapes every one of ${MAX_FACES} faces`, async ({ page }) => {
  await openHarness(page);
  // Half-size portraits (alternating a and b) in a grid, with their landmarks remapped.
  const columns = Math.ceil(MAX_FACES / 2);
  const cell = { width: 320, height: 400 };
  const width = cell.width * columns;
  const height = cell.height * 2;
  const url = await page.evaluate(
    async ({ count, columns, cell, width, height }) => {
      const portraits = await Promise.all(
        ['portrait-a', 'portrait-b'].map(async (name) => createImageBitmap(await (await fetch(`/tests/fixtures/${name}.jpg`)).blob())),
      );
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      for (let i = 0; i < count; i++) ctx.drawImage(portraits[i % 2]!, (i % columns) * cell.width, Math.floor(i / columns) * cell.height, cell.width, cell.height);
      return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
    },
    { count: MAX_FACES, columns, cell, width, height },
  );
  const analysis: FaceAnalysis = {
    imageWidth: width,
    imageHeight: height,
    faces: Array.from({ length: MAX_FACES }, (_, i) => {
      const face = analysisOf(PORTRAITS[i % 2]!).faces[0]!;
      const [col, row] = [i % columns, Math.floor(i / columns)];
      return {
        landmarks: face.landmarks.map((p) => ({ x: (col + p.x) / columns, y: (row + p.y) / 2 })),
        box: { x: (col + face.box.x) / columns, y: (row + face.box.y) / 2, width: face.box.width / columns, height: face.box.height / 2 },
      };
    }),
  };
  const renderGrid = (layers: AnyLayer[]) => render(page, { image: { url }, layers, analysis });
  const at = (face: FaceAnalysis['faces'][number], landmark: number, half: number): Patch => {
    const p = face.landmarks[landmark]!;
    return { x: Math.round(p.x * width), y: Math.round(p.y * height), half };
  };
  const mouth = (face: FaceAnalysis['faces'][number]): Patch => {
    const [upper, lower] = [at(face, 13, 3), at(face, 14, 3)];
    return { x: Math.round((upper.x + lower.x) / 2), y: Math.round((upper.y + lower.y) / 2), half: 3 };
  };
  const before = await renderGrid([]);
  const smooth = await renderGrid(STRONG.smooth!);
  const whiten = await renderGrid(STRONG.whiten!);
  const teeth = await renderGrid(STRONG.teeth!);
  const eyes = await renderGrid(STRONG.eyes!);
  for (const face of analysis.faces) {
    expect(patchDiff(smooth, before, at(face, 50, 5))).toBeGreaterThan(1);
    expect(meanLumaIn(whiten, at(face, 50, 4)) - meanLumaIn(before, at(face, 50, 4))).toBeGreaterThan(8);
    expect(patchDiff(teeth, before, mouth(face))).toBeGreaterThan(5);
    expect(patchDiff(eyes, before, at(face, 468, 5))).toBeGreaterThan(5);
  }
  await writeComparison(page, `${MAX_FACES}-faces-natural.png`, before, await renderGrid(NATURAL));
});

test('smooths a small face next to a large one at its own scale', async ({ page }) => {
  await openHarness(page);
  // portrait-b at 40% of portrait-a's size, pasted into portrait-a's top-right corner.
  const big = await render(page, { image: { url: '/tests/fixtures/portrait-a.jpg' }, layers: [], maxSize: 400 });
  const small = await render(page, { image: { url: '/tests/fixtures/portrait-b.jpg' }, layers: [], maxSize: 160 });
  const offsetX = big.width - small.width;
  const data = Array.from(big.data);
  for (let y = 0; y < small.height; y++) {
    for (let i = 0; i < small.width * 4; i++) data[(y * big.width + offsetX) * 4 + i] = small.data[y * small.width * 4 + i]!;
  }
  const image = { width: big.width, height: big.height, data };
  const s = small.width / big.width;
  const bigFace = analysisOf('portrait-a').faces[0]!;
  const smallFace = analysisOf('portrait-b').faces[0]!;
  const placed = {
    landmarks: smallFace.landmarks.map((p) => ({ x: offsetX / big.width + p.x * s, y: p.y * s })),
    box: { x: offsetX / big.width + smallFace.box.x * s, y: smallFace.box.y * s, width: smallFace.box.width * s, height: smallFace.box.height * s },
  };
  const analysis = (faces: FaceAnalysis['faces']): FaceAnalysis => ({ imageWidth: big.width, imageHeight: big.height, faces });
  const original = await render(page, { image, layers: [], analysis: analysis([bigFace, placed]) });
  const together = await render(page, { image, layers: STRONG.smooth!, analysis: analysis([bigFace, placed]) });
  const alone = await render(page, { image, layers: STRONG.smooth!, analysis: analysis([placed]) });
  const bigAlone = await render(page, { image, layers: STRONG.smooth!, analysis: analysis([bigFace]) });
  const box = placed.box;
  const smallPatch = {
    x: Math.round((box.x + box.width / 2) * big.width),
    y: Math.round((box.y + box.height / 2) * big.height),
    half: Math.round((box.width * big.width) / 2),
  };
  const effect = patchDiff(alone, original, smallPatch);
  expect(effect).toBeGreaterThan(0.5);
  expect(patchDiff(together, alone, smallPatch)).toBeLessThan(effect * 0.3);
  const bigPatch = { x: Math.round(bigFace.landmarks[1]!.x * big.width), y: Math.round(bigFace.landmarks[1]!.y * big.height), half: 50 };
  expect(patchDiff(together, bigAlone, bigPatch)).toBeLessThan(0.05);
});

test.describe('visual review images', () => {
  for (const name of PORTRAITS) {
    test(`writes before/after PNGs for ${name}`, async ({ page }) => {
      await openHarness(page);
      const analysis = analysisOf(name);
      const box = analysis.faces[0]!.box;
      const before = await renderPortrait(page, name, []);
      const cases: Record<string, AnyLayer[]> = { ...STRONG, natural: NATURAL };
      for (const [label, layers] of Object.entries(cases)) {
        const after = await renderPortrait(page, name, layers);
        expect(meanAbsDiff(after, before)).toBeGreaterThan(0);
        await writeComparison(page, `${name}-${label}.png`, before, after);
        await writeComparison(page, `${name}-${label}-face.png`, before, after, box);
      }
    });
  }
});
