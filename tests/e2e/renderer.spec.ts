import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DEFAULT_PARAMS, type AnyLayer, type Layer, type LayerKind, type LayerParams } from '../../src/engine/types';
import type { FaceAnalysis } from '../../src/face/types';
import { makeImage, meanAbsDiff, openHarness, pixelAt, render, type Pixels } from './harness';

type TransformParams = LayerParams['transform'];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function layer<K extends LayerKind>(kind: K, params: Partial<LayerParams[K]> = {}, opacity = 1): AnyLayer {
  const typed: Layer<K> = { id: kind, kind, enabled: true, opacity, params: { ...DEFAULT_PARAMS[kind], ...params } };
  return typed as AnyLayer;
}

/** `layers` with the params of the `kind` layer updated. */
function withParams(layers: AnyLayer[], kind: LayerKind, params: Record<string, number>): AnyLayer[] {
  return layers.map((l) => (l.kind === kind ? ({ ...l, params: { ...l.params, ...params } } as AnyLayer) : l));
}

/** 640 x 800 portrait with cached landmarks. */
const PORTRAIT = { url: '/tests/fixtures/portrait-a.jpg' };
const analysis = JSON.parse(readFileSync('tests/fixtures/portrait-a.faces.json', 'utf8')) as FaceAnalysis;

/** A uniform image of any size, generated in the page. */
function flatImage(width: number, height: number, [r, g, b]: [number, number, number]) {
  return { width: 1, height: 1, data: [r, g, b, 255], resize: { width, height } };
}

function cropPixels(p: Pixels, r: Rect): Pixels {
  const data = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const from = ((r.y + y) * p.width + r.x) * 4;
    data.set(p.data.subarray(from, from + r.width * 4), y * r.width * 4);
  }
  return { width: r.width, height: r.height, data };
}

/** Pixels at least `margin` px away from every edge. */
function interior(p: Pixels, margin: number): Pixels {
  return cropPixels(p, { x: margin, y: margin, width: p.width - 2 * margin, height: p.height - 2 * margin });
}

function maxAbsDiff(a: Pixels, b: Pixels): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let max = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) max = Math.max(max, Math.abs(a.data[i]! - b.data[i]!));
  return max;
}

/** CPU reference of the transform stage: rotate clockwise, flip, then crop (normalised to the rotated image). */
function orient(p: Pixels, t: TransformParams): Pixels {
  const swap = t.rotate === 90 || t.rotate === 270;
  const rw = swap ? p.height : p.width;
  const rh = swap ? p.width : p.height;
  const rotated = new Uint8ClampedArray(rw * rh * 4);
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      let [tx, ty] =
        t.rotate === 90 ? [p.height - 1 - y, x] : t.rotate === 180 ? [p.width - 1 - x, p.height - 1 - y] : t.rotate === 270 ? [y, p.width - 1 - x] : [x, y];
      if (t.flipH) tx = rw - 1 - tx;
      if (t.flipV) ty = rh - 1 - ty;
      rotated.set(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4), (ty * rw + tx) * 4);
    }
  }
  const c = t.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const rect = { x: Math.round(rw * c.x), y: Math.round(rh * c.y), width: Math.round(rw * c.width), height: Math.round(rh * c.height) };
  return cropPixels({ width: rw, height: rh, data: rotated }, rect);
}

function corners(p: Pixels): number[] {
  return [pixelAt(p, 0, 0), pixelAt(p, p.width - 1, 0), pixelAt(p, 0, p.height - 1), pixelAt(p, p.width - 1, p.height - 1)].map((c) => c[0]);
}

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test.describe('crop first', () => {
  test('colour and detail layers render a crop exactly as that part of the whole photo', async ({ page }) => {
    const layers = [
      layer('adjust', { exposure: 0.3, contrast: 0.25, saturation: 0.2, temperature: 0.15 }),
      layer('filter', { lookId: 'film', intensity: 0.8 }),
      layer('sharpen', { amount: 0.8, radius: 0.5 }),
      layer('filter', { lookId: 'mono', intensity: 1 }, 0.5),
    ];
    const orientations: Omit<TransformParams, 'crop'>[] = [
      { rotate: 0, flipH: false, flipV: false },
      { rotate: 90, flipH: true, flipV: false },
      { rotate: 180, flipH: false, flipV: false },
      { rotate: 270, flipH: false, flipV: true },
    ];
    for (const effect of layers) {
      const whole = await render(page, { image: PORTRAIT, layers: [effect], analysis });
      for (const orientation of orientations) {
        const transform = { ...orientation, crop: { x: 0.2, y: 0.16, width: 0.6, height: 0.64 } };
        const cropped = await render(page, { image: PORTRAIT, layers: [effect, layer('transform', transform)], analysis });
        // The unsharp mask blurs across the crop edge, so compare beyond its reach.
        const diff = maxAbsDiff(interior(cropped, 8), interior(orient(whole, transform), 8));
        expect(diff, `${effect.kind} at opacity ${effect.opacity}, ${JSON.stringify(orientation)}`).toBe(0);
      }
    }
  });

  test('retouching finds the face inside a crop', async ({ page }) => {
    // Aligned to 64 px, so the skin filter's reduced-resolution statistics sample the same pixels.
    const rect = { x: 128, y: 128, width: 384, height: 512 };
    const crop = layer('transform', { crop: { x: rect.x / 640, y: rect.y / 800, width: rect.width / 640, height: rect.height / 800 } });
    const original = cropPixels(await render(page, { image: PORTRAIT, layers: [] }), rect);
    const layers = [
      layer('skinSmooth', { amount: 0.7 }),
      layer('skinWhiten', { amount: 0.6 }),
      layer('teethWhiten', { amount: 0.8 }),
      layer('faceReshape', { slim: 0.6, eyes: 0.5, nose: 0.4, chin: 0.3 }),
    ];
    // Mask feathers reach beyond the crop edge, where the crop has no pixels to blur.
    const margin = 48;
    // Masks are rasterised, and the warp sampled, at the crop's size, which can round a level differently.
    const tolerance = 1;
    for (const effect of layers) {
      const whole = cropPixels(await render(page, { image: PORTRAIT, layers: [effect], analysis }), rect);
      const cropped = await render(page, { image: PORTRAIT, layers: [effect, crop], analysis });
      expect(meanAbsDiff(whole, original), `${effect.kind} is visible`).toBeGreaterThan(0.05);
      expect(maxAbsDiff(interior(cropped, margin), interior(whole, margin)), effect.kind).toBeLessThanOrEqual(tolerance);
    }
  });

  test('a vignette is centred on the crop', async ({ page }) => {
    const grey = flatImage(96, 64, [160, 160, 160]);
    const transforms: Partial<TransformParams>[] = [
      { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      { rotate: 90, crop: { x: 0.5, y: 0.25, width: 0.5, height: 0.75 } },
    ];
    for (const transform of transforms) {
      const out = await render(page, { image: grey, layers: [layer('vignette', { amount: -0.6 }), layer('transform', transform)] });
      const c = corners(out);
      expect(Math.max(...c) - Math.min(...c), JSON.stringify(transform)).toBeLessThanOrEqual(1);
      expect(c[0]).toBeLessThan(130);
      expect(Math.abs(pixelAt(out, out.width >> 1, out.height >> 1)[0] - 160)).toBeLessThanOrEqual(1);
    }
  });

  test('a disabled transform crops nothing', async ({ page }) => {
    const image = makeImage(48, 32, (x, y) => [x * 5, y * 7, 90]);
    const vignette = layer('vignette', { amount: -0.6 });
    const disabled = { ...layer('transform', { rotate: 90, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }), enabled: false };
    const out = await render(page, { image, layers: [vignette, disabled] });
    const plain = await render(page, { image, layers: [vignette] });
    expect([out.width, out.height]).toEqual([48, 32]);
    expect(maxAbsDiff(out, plain)).toBe(0);
  });

  test('the output size is unchanged for every crop, rotation and flip', async ({ page }) => {
    const crops = [null, { x: 0.13, y: 0.4, width: 0.55, height: 0.34 }, { x: 0.5, y: 0, width: 0.01, height: 1 }];
    const cases: TransformParams[] = [];
    for (const rotate of [0, 90, 180, 270] as const) {
      for (const [flipH, flipV] of [[false, false], [true, true]] as const) for (const crop of crops) cases.push({ rotate, flipH, flipV, crop });
    }
    const sizes = await page.evaluate(
      async ({ cases, layers }) => {
        const h = window.omHarness;
        const bitmap = await h.loadImage({ width: 1, height: 1, data: [90, 120, 150, 255], resize: { width: 37, height: 23 } });
        const r = h.createRenderer();
        r.setSource(bitmap);
        const out = cases.map((params) => {
          const stack = [...layers, { id: 't', kind: 'transform', enabled: true, opacity: 1, params } as const];
          const measured = r.measureOutput(stack);
          const pixels = r.renderToPixels(stack);
          return { measured: [measured.width, measured.height], rendered: [pixels.width, pixels.height] };
        });
        r.dispose();
        bitmap.close();
        return out;
      },
      { cases, layers: [layer('adjust', { exposure: 0.5 })] },
    );
    cases.forEach((params, i) => {
      const swap = params.rotate === 90 || params.rotate === 270;
      const [rw, rh] = swap ? [23, 37] : [37, 23];
      const c = params.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const expected = [Math.max(1, Math.round(rw * c.width)), Math.max(1, Math.round(rh * c.height))];
      expect(sizes[i]!.measured, JSON.stringify(params)).toEqual(expected);
      expect(sizes[i]!.rendered, JSON.stringify(params)).toEqual(expected);
    });
  });

  test('a preview of a crop only processes the cropped pixels', async ({ page }) => {
    const draws = await page.evaluate(async (layers) => {
      const h = window.omHarness;
      const bitmap = await h.loadImage({ width: 1, height: 1, data: [120, 110, 100, 255], resize: { width: 2000, height: 1600 } });
      const r = h.createRenderer();
      r.setSource(bitmap);
      const log = h.traceDraws(r);
      // The crop is 400 x 400 source pixels, shown at 200 x 200.
      r.renderPreview(layers, { width: 200, height: 200 });
      r.dispose();
      bitmap.close();
      return log;
    }, [layer('skinSmooth', { amount: 0.5 }), layer('adjust', { exposure: 0.2 }), layer('transform', { crop: { x: 0.3, y: 0.3, width: 0.2, height: 0.25 } })]);
    expect(draws.length).toBeGreaterThan(5);
    for (const d of draws) expect(d.width * d.height, d.program).toBeLessThanOrEqual(200 * 200);
  });
});

test.describe('sources larger than the GPU texture limit', () => {
  // 200 x 100 uploads as 64 x 32.
  const image = flatImage(200, 100, [180, 120, 60]);

  test('renderToPixels honours maxSize', async ({ page }) => {
    const out = await render(page, { image, layers: [layer('adjust', { exposure: 0.3 })], maxSize: 32, maxTextureSize: 64 });
    expect([out.width, out.height]).toEqual([32, 16]);
    const full = await render(page, { image, layers: [], maxTextureSize: 64 });
    expect([full.width, full.height]).toEqual([64, 32]);
  });

  test('a preview renders at the canvas size', async ({ page }) => {
    const result = await page.evaluate(async (image) => {
      const h = window.omHarness;
      const bitmap = await h.loadImage(image);
      const r = h.createRenderer({ maxTextureSize: 64 });
      r.setSource(bitmap);
      const log = h.traceDraws(r);
      const size = r.renderPreview([], { width: 32, height: 16 });
      r.dispose();
      bitmap.close();
      return { size, largest: Math.max(...log.map((d) => d.width * d.height)) };
    }, image);
    expect(result.size).toEqual({ width: 32, height: 16 });
    expect(result.largest).toBeLessThanOrEqual(32 * 16);
  });
});

test('fading face reshaping weakens the warp instead of blending two geometries', async ({ page }) => {
  const params = { slim: 1, eyes: 1, nose: 0.6, chin: 0.4 };
  const faded = await render(page, { image: PORTRAIT, layers: [layer('faceReshape', params, 0.5)], analysis });
  const half = await render(page, {
    image: PORTRAIT,
    layers: [layer('faceReshape', { slim: 0.5, eyes: 0.5, nose: 0.3, chin: 0.2 })],
    analysis,
  });
  const original = await render(page, { image: PORTRAIT, layers: [] });
  expect(meanAbsDiff(faded, original)).toBeGreaterThan(0.2);
  expect(maxAbsDiff(faded, half)).toBe(0);
});

test('a preview re-renders only from the first layer that changed', async ({ page }) => {
  const base = [
    layer('skinSmooth', { amount: 0.6 }),
    layer('skinWhiten', { amount: 0.4 }),
    layer('faceReshape', { eyes: 0.4 }),
    layer('adjust', { exposure: 0.2 }),
    layer('grain', { amount: 0.3 }),
    layer('vignette', { amount: -0.4 }),
  ];
  const exposed = withParams(withParams(base, 'grain', { amount: 0.7 }), 'adjust', { exposure: 0.5 });
  const crop = layer('transform', { rotate: 90, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.7 } });
  interface Step {
    layers: AnyLayer[];
    showOriginal?: boolean;
    face?: boolean;
    /** The retouching layers before the change must not run again. */
    reusesRetouch?: boolean;
  }
  const steps: Step[] = [
    { layers: base },
    { layers: withParams(base, 'grain', { amount: 0.5 }) },
    { layers: withParams(base, 'grain', { amount: 0.7 }), reusesRetouch: true },
    { layers: withParams(withParams(base, 'grain', { amount: 0.7 }), 'adjust', { exposure: 0.4 }) },
    { layers: exposed, reusesRetouch: true },
    { layers: exposed, showOriginal: true },
    { layers: exposed, reusesRetouch: true },
    { layers: [...exposed, crop] },
    { layers: [...withParams(exposed, 'vignette', { amount: -0.6 }), crop] },
    { layers: [...withParams(exposed, 'vignette', { amount: -0.8 }), crop], reusesRetouch: true },
    { layers: [...withParams(exposed, 'vignette', { amount: -0.8 }), crop].map((l) => (l.kind === 'skinSmooth' ? { ...l, opacity: 0.5 } : l)) },
    // A new analysis drops the cache; the first change after it shows which layer to keep.
    { layers: [...withParams(exposed, 'vignette', { amount: -0.9 }), crop], face: false },
    { layers: [...withParams(exposed, 'vignette', { amount: -1 }), crop], face: false },
    { layers: [...withParams(exposed, 'vignette', { amount: -0.95 }), crop], face: false, reusesRetouch: true },
    { layers: [...withParams(exposed, 'vignette', { amount: -0.95 }), crop] },
  ];
  const results = await page.evaluate(
    async ({ image, analysis, steps }) => {
      const h = window.omHarness;
      const bitmap = await h.loadImage(image);
      const cached = h.createRenderer();
      const reference = h.createRenderer();
      cached.setSource(bitmap);
      const log = h.traceDraws(cached);
      let face: boolean | null = null;
      const out = [];
      for (const step of steps) {
        const withFace = step.face ?? true;
        if (withFace !== face) cached.setAnalysis(withFace ? analysis : null);
        face = withFace;
        log.length = 0;
        const opts = { width: 320, height: 400, showOriginal: step.showOriginal };
        cached.renderPreview(step.layers, opts);
        // A fresh source leaves nothing cached.
        reference.setSource(bitmap);
        reference.setAnalysis(withFace ? analysis : null);
        reference.renderPreview(step.layers, opts);
        const a = h.readCanvas(cached);
        const b = h.readCanvas(reference);
        let diff = a.length === b.length ? 0 : Infinity;
        for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
        out.push({ diff, programs: [...new Set(log.map((d) => d.program))] });
      }
      cached.dispose();
      reference.dispose();
      bitmap.close();
      return out;
    },
    { image: PORTRAIT, analysis, steps },
  );
  const retouching = (programs: string[]) => programs.filter((p) => /^(skinSmooth|skinWhiten|faceReshape|faceMask)/.test(p));
  results.forEach((r, i) => {
    expect(r.diff, `step ${i}`).toBe(0);
    if (steps[i]!.reusesRetouch) expect(retouching(r.programs), `step ${i}`).toEqual([]);
  });
  expect(retouching(results[3]!.programs), 'a change before the cached layer renders everything').not.toEqual([]);
});

test('a preview after re-importing a LUT under the same id shows the new LUT', async ({ page }) => {
  const stacks = [0.3, 0.4, 0.5, 0.6].map((amount) => [layer('filter', { lookId: 'custom:x', intensity: 1 }), layer('grain', { amount })]);
  const result = await page.evaluate(
    async ({ image, stacks }) => {
      const h = window.omHarness;
      // 2-point LUTs: the identity, and one that swaps red and blue.
      const lut = (swap: boolean) => {
        const data = new Uint8Array(8 * 4);
        for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) {
          data.set([(swap ? b : r) * 255, g * 255, (swap ? r : b) * 255, 255], ((b * 2 + g) * 2 + r) * 4);
        }
        return { size: 2, data };
      };
      const bitmap = await h.loadImage(image);
      const opts = { width: 320, height: 400 };
      const cached = h.createRenderer();
      cached.setSource(bitmap);
      cached.registerCustomLut('x', lut(false));
      // The second and third frames keep and reuse the texture entering the grain layer.
      for (const layers of stacks.slice(0, 3)) cached.renderPreview(layers, opts);
      const before = h.readCanvas(cached);
      cached.registerCustomLut('x', lut(true));
      cached.renderPreview(stacks[3]!, opts);
      const reference = h.createRenderer();
      reference.setSource(bitmap);
      reference.registerCustomLut('x', lut(true));
      reference.renderPreview(stacks[3]!, opts);
      const [a, b] = [h.readCanvas(cached), h.readCanvas(reference)];
      let diff = 0;
      let lutChange = 0;
      for (let i = 0; i < a.length; i++) {
        diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
        lutChange = Math.max(lutChange, Math.abs(before[i]! - b[i]!));
      }
      cached.dispose();
      reference.dispose();
      bitmap.close();
      return { diff, lutChange };
    },
    { image: PORTRAIT, stacks },
  );
  expect(result.lutChange, 'the new LUT is visible').toBeGreaterThan(50);
  expect(result.diff).toBe(0);
});

test.describe('render target pool', () => {
  test('an export leaves no full-resolution textures behind', async ({ page }) => {
    const result = await page.evaluate(async (layers) => {
      const h = window.omHarness;
      const bitmap = await h.loadImage({ width: 1, height: 1, data: [200, 150, 120, 255], resize: { width: 1200, height: 900 } });
      const r = h.createRenderer();
      r.setSource(bitmap);
      const liveBytes = h.traceTextures(r);
      r.renderPreview(layers, { width: 300, height: 225 });
      const afterPreview = { pool: r.gpu.pool, live: liveBytes() };
      const exported = r.renderToPixels(layers);
      const afterExport = { pool: r.gpu.pool, live: liveBytes() };
      r.dispose();
      bitmap.close();
      return { afterPreview, afterExport, frameBytes: exported.width * exported.height * 4 };
    }, [layer('skinSmooth', { amount: 0.5 }), layer('sharpen', { amount: 0.5 }), layer('transform', { crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } })]);
    expect(result.afterPreview.pool.targets).toBeGreaterThan(0);
    expect(result.afterExport.pool).toEqual({ targets: 0, bytes: 0 });
    // Neither pooled targets nor the export's working copy and cached masks stay allocated.
    expect(result.afterExport.live).toBeLessThan(result.frameBytes);
    expect(result.afterExport.live).toBeLessThanOrEqual(result.afterPreview.live);
  });

  test("an export of the whole photo keeps the preview's working image", async ({ page }) => {
    const programs = await page.evaluate(
      async ([first, second]) => {
        const h = window.omHarness;
        const bitmap = await h.loadImage({ width: 1, height: 1, data: [200, 150, 120, 255], resize: { width: 1200, height: 900 } });
        const r = h.createRenderer();
        r.setSource(bitmap);
        r.renderPreview(first!, { width: 300, height: 225 });
        r.renderToPixels(first!);
        const log = h.traceDraws(r);
        r.renderPreview(second!, { width: 300, height: 225 });
        r.dispose();
        bitmap.close();
        return [...new Set(log.map((d) => d.program))];
      },
      [[layer('adjust', { exposure: 0.2 })], [layer('adjust', { exposure: 0.3 })]],
    );
    expect(programs).toContain('pass.adjust');
    expect(programs, 'the preview does not downscale the photo again').not.toContain('renderer.region');
  });

  test('is bounded in bytes', async ({ page }) => {
    const pool = await page.evaluate(() => {
      const r = window.omHarness.createRenderer();
      const big = Array.from({ length: 5 }, () => r.gpu.acquire(4096, 4096));
      for (const t of big) r.gpu.release(t);
      const result = r.gpu.pool;
      r.dispose();
      return result;
    });
    expect(pool.targets).toBeGreaterThan(0);
    expect(pool.targets).toBeLessThan(5);
    expect(pool.bytes).toBe(pool.targets * 4096 * 4096 * 4);
    expect(pool.bytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  });
});

test.describe('gaussian blur', () => {
  /** Blur a vertical step edge (0 -> 200 at column `edge`) and return the middle row's red channel and the draws. */
  async function blurStep(page: import('@playwright/test').Page, sigma: number, edge: number) {
    return page.evaluate(
      ({ sigma, edge }) => {
        const h = window.omHarness;
        const r = h.createRenderer();
        const gpu = r.gpu;
        const width = 512;
        const height = 32;
        const data = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x < edge ? 0 : 200, 0, 0, 255], (y * width + x) * 4);
        const input = gpu.createTexture(width, height, data);
        const output = gpu.acquire(width, height);
        const log = h.traceDraws(r);
        h.gaussianBlur(gpu, input, output, sigma);
        const pixels = gpu.readPixels(output);
        r.dispose();
        const row = Array.from({ length: width }, (_, x) => pixels[((height >> 1) * width + x) * 4]!);
        return { row, draws: log.filter((d) => d.program === 'blur.gauss1d') };
      },
      { sigma, edge },
    );
  }

  function erf(x: number): number {
    // Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  }

  test('matches the exact Gaussian on both sides of the reduced-resolution threshold', async ({ page }) => {
    for (const sigma of [1.5, 3.9, 4.1, 6, 8.5, 12.5, 20]) {
      for (const edge of [256, 251]) {
        const { row } = await blurStep(page, sigma, edge);
        let worst = 0;
        for (let x = 64; x < 448; x++) {
          const expected = 100 * (1 + erf((x + 0.5 - edge) / (sigma * Math.SQRT2)));
          worst = Math.max(worst, Math.abs(row[x]! - expected));
        }
        expect(worst, `sigma ${sigma}, edge ${edge}`).toBeLessThanOrEqual(2.5);
      }
    }
  });

  test('a medium blur runs its taps at reduced resolution', async ({ page }) => {
    const { draws } = await blurStep(page, 8, 256);
    expect(draws.length).toBe(2);
    for (const d of draws) expect(d.width * d.height).toBeLessThanOrEqual((512 * 32) / 4);
  });
});

test('the preview keeps transparency for the page behind the canvas', async ({ page }) => {
  const pixels = await page.evaluate(async () => {
    const h = window.omHarness;
    // Left half transparent, right half half-transparent orange.
    const data = Array.from({ length: 8 * 4 }, (_, i) => [200, 120, 40, (i % 8) < 4 ? 0 : 128]).flat();
    const bitmap = await h.loadImage({ width: 8, height: 4, data });
    const r = h.createRenderer();
    r.setSource(bitmap);
    r.renderPreview([], { width: 8, height: 4 });
    const canvas = Array.from(h.readCanvas(r));
    r.dispose();
    bitmap.close();
    return canvas;
  });
  for (let i = 0; i < pixels.length; i += 4) {
    const x = (i / 4) % 8;
    if (x < 4) expect(pixels[i + 3]).toBe(0);
    else expect(pixels.slice(i, i + 4)).toEqual([200, 120, 40, 128]);
  }
});
