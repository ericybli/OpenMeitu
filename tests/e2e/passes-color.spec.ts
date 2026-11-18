import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_PARAMS, type AnyLayer, type Layer, type LayerKind, type LayerParams } from '../../src/engine/types';
import { makeImage, meanAbsDiff, meanLuma, openHarness, pixelAt, render, type HarnessImage, type Pixels } from './harness';

type Image = ReturnType<typeof makeImage>;
type Rgb = [number, number, number];

function layer<K extends LayerKind>(kind: K, params: Partial<LayerParams[K]> = {}): AnyLayer {
  const typed: Layer<K> = { id: `test-${kind}`, kind, enabled: true, opacity: 1, params: { ...DEFAULT_PARAMS[kind], ...params } };
  return typed as AnyLayer;
}

function asPixels(image: Image): Pixels {
  return { width: image.width, height: image.height, data: Uint8ClampedArray.from(image.data) };
}

function rgbAt(p: Pixels, x: number, y: number): Rgb {
  const [r, g, b] = pixelAt(p, x, y);
  return [r, g, b];
}

function maxAbsDiff(a: Pixels, b: Pixels): number {
  let max = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (i % 4 === 3) continue;
    max = Math.max(max, Math.abs(a.data[i]! - b.data[i]!));
  }
  return max;
}

function toLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearLuminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** HSL hue in degrees. */
function hue([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h * 60;
}

function chroma(c: Rgb): number {
  return Math.max(...c) - Math.min(...c);
}

function lumaStd(p: Pixels): number {
  const mean = meanLuma(p);
  let sum = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    const l = 0.2126 * p.data[i]! + 0.7152 * p.data[i + 1]! + 0.0722 * p.data[i + 2]!;
    sum += (l - mean) ** 2;
  }
  return Math.sqrt(sum / (p.data.length / 4));
}

/** Box downsample by an integer factor (what the renderer's preview path does to the source). */
function downsample(p: Pixels, factor: number): Pixels {
  const width = Math.floor(p.width / factor);
  const height = Math.floor(p.height / factor);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) sum += p.data[((factor * y + dy) * p.width + factor * x + dx) * 4 + c]!;
        }
        data[(y * width + x) * 4 + c] = Math.round(sum / (factor * factor));
      }
    }
  }
  return { width, height, data };
}

/** Red channel as signed offsets from `base` (grain is added equally to all channels). */
function redOffsets(p: Pixels, base: number): number[] {
  return Array.from({ length: p.width * p.height }, (_, i) => p.data[i * 4]! - base);
}

function standardDeviation(values: number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/** Mean squared difference between horizontal (dx = 1) or vertical (dy = 1) neighbours, grouped by x or y modulo `period`. */
function neighbourEnergyByPhase(p: Pixels, axis: 'x' | 'y', period: number): number[] {
  const sums = new Array<number>(period).fill(0);
  const counts = new Array<number>(period).fill(0);
  const [dx, dy] = axis === 'x' ? [1, 0] : [0, 1];
  for (let y = 0; y + dy < p.height; y++) {
    for (let x = 0; x + dx < p.width; x++) {
      const phase = (axis === 'x' ? x : y) % period;
      sums[phase]! += (pixelAt(p, x + dx, y + dy)[0] - pixelAt(p, x, y)[0]) ** 2;
      counts[phase]!++;
    }
  }
  return sums.map((s, i) => s / counts[i]!);
}

/** Correlation between horizontally adjacent pixels' red channel. */
function lagOneCorrelation(p: Pixels): number {
  const values = redOffsets(p, 0);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  let num = 0;
  let den = 0;
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const a = values[y * p.width + x]! - mean;
      den += a * a;
      if (x + 1 < p.width) num += a * (values[y * p.width + x + 1]! - mean);
    }
  }
  return num / den;
}

function buildLut(size: number, fn: (r: number, g: number, b: number) => Rgb): { size: number; data: number[] } {
  const data: number[] = [];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        data.push(...out.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), 255);
      }
    }
  }
  return { size, data };
}

/** Varied hues, saturations and luminances, including pure black and white. */
const colourful = makeImage(48, 24, (x, y) => {
  if (x === 0) return [0, 0, 0];
  if (x === 1) return [255, 255, 255];
  return [(x * 37 + y * 11) % 256, (x * 13 + y * 29) % 256, (x * 7 + y * 41 + 90) % 256];
});

/** Horizontal grey ramp 0..255. */
const greyRamp = makeImage(256, 4, (x) => [x, x, x]);

const flat = (v: Rgb, size = 32) => makeImage(size, size, () => v);

function renderLayers(page: Page, image: HarnessImage, layers: AnyLayer[], maxSize?: number) {
  return render(page, { image, layers, maxSize });
}

/**
 * Grain follows the photo's diagonal. A 2400 x 1800 photo has the 3000 px
 * reference diagonal, where cells span 1..4 px. Tests look at a 256 px crop of
 * it, which keeps transfers small and does not change the grain.
 */
const REFERENCE_PHOTO = { width: 2400, height: 1800 };
const window256 = layer('transform', { crop: { x: 0.4, y: 0.4, width: 256 / 2400, height: 256 / 1800 } });

/** A uniform photo of any size, generated in the page. */
function greyPhoto(v: number, size = REFERENCE_PHOTO): HarnessImage {
  return { width: 1, height: 1, data: [v, v, v, 255], resize: size };
}

function grainOnGrey(page: Page, v: number, params: Partial<LayerParams['grain']>, maxSize?: number) {
  return renderLayers(page, greyPhoto(v), [layer('grain', params), window256], maxSize);
}

function rampRow(p: Pixels): number[] {
  return Array.from({ length: p.width }, (_, x) => pixelAt(p, x, 1)[0]);
}

function expectNonDecreasing(values: number[]) {
  for (let i = 1; i < values.length; i++) expect(values[i]!, `index ${i}`).toBeGreaterThanOrEqual(values[i - 1]!);
}

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test.describe('adjust', () => {
  const keys = Object.keys(DEFAULT_PARAMS.adjust) as (keyof LayerParams['adjust'])[];

  test('a tiny value of any single parameter keeps the image within 1 LSB', async ({ page }) => {
    const input = asPixels(colourful);
    for (const key of keys) {
      for (const value of [1e-4, -1e-4]) {
        const out = await renderLayers(page, colourful, [layer('adjust', { [key]: value })]);
        expect(maxAbsDiff(out, input), `${key}=${value}`).toBeLessThanOrEqual(1);
      }
    }
  });

  test('exposure scales linear light by 2^EV and is monotonic', async ({ page }) => {
    const grey = flat([118, 118, 118]);
    const base = toLinear(118);
    const up = await renderLayers(page, grey, [layer('adjust', { exposure: 1 })]);
    const down = await renderLayers(page, grey, [layer('adjust', { exposure: -1 })]);
    expect(toLinear(pixelAt(up, 5, 5)[0]) / base).toBeCloseTo(2, 1);
    expect(toLinear(pixelAt(down, 5, 5)[0]) / base).toBeCloseTo(0.5, 1);

    let previous = -1;
    for (const exposure of [-2, -1, -0.3, 0.3, 1, 2]) {
      const out = await renderLayers(page, greyRamp, [layer('adjust', { exposure })]);
      const row = rampRow(out);
      expectNonDecreasing(row);
      expect(meanLuma(out)).toBeGreaterThan(previous);
      previous = meanLuma(out);
      if (exposure > 0) expect(row[255]).toBe(255);
    }
  });

  test('exposure rolls highlights off instead of clipping them', async ({ page }) => {
    const out = await renderLayers(page, greyRamp, [layer('adjust', { exposure: 1 })]);
    const row = rampRow(out);
    // Only the very top of the ramp may reach white.
    expect(row.findIndex((v) => v === 255)).toBeGreaterThan(245);
  });

  test('contrast is an S-curve around mid-grey', async ({ page }) => {
    const input = asPixels(greyRamp);
    const more = await renderLayers(page, greyRamp, [layer('adjust', { contrast: 0.6 })]);
    const less = await renderLayers(page, greyRamp, [layer('adjust', { contrast: -0.6 })]);
    expect(lumaStd(more)).toBeGreaterThan(lumaStd(input) * 1.05);
    expect(lumaStd(less)).toBeLessThan(lumaStd(input) * 0.95);
    // The midtone spread around the pivot changes the most.
    const spread = (out: Pixels) => rampRow(out)[170]! - rampRow(out)[70]!;
    expect(spread(more)).toBeGreaterThan(115);
    expect(spread(less)).toBeLessThan(85);
    for (const out of [more, less]) {
      const row = rampRow(out);
      expectNonDecreasing(row);
      expect(row[0]).toBe(0);
      expect(row[255]).toBe(255);
      expect(Math.abs(row[118]! - 118)).toBeLessThanOrEqual(1);
    }
    expect(rampRow(more)[60]).toBeLessThan(55);
    expect(rampRow(more)[200]).toBeGreaterThan(205);
  });

  test('highlights and shadows act on their own tonal range and stay monotonic', async ({ page }) => {
    const row = async (params: Partial<LayerParams['adjust']>) =>
      rampRow(await renderLayers(page, greyRamp, [layer('adjust', params)]));

    const recover = await row({ highlights: -1 });
    expectNonDecreasing(recover);
    expect(recover[220]).toBeLessThan(205);
    expect(Math.abs(recover[60]! - 60)).toBeLessThanOrEqual(1);

    const boost = await row({ highlights: 1 });
    expectNonDecreasing(boost);
    expect(boost[200]).toBeGreaterThan(208);
    expect(boost[255]).toBe(255);
    expect(Math.abs(boost[60]! - 60)).toBeLessThanOrEqual(1);

    const lift = await row({ shadows: 1 });
    expectNonDecreasing(lift);
    expect(lift[40]).toBeGreaterThan(55);
    expect(lift[0]).toBe(0);
    expect(Math.abs(lift[200]! - 200)).toBeLessThanOrEqual(1);

    const deepen = await row({ shadows: -1 });
    expectNonDecreasing(deepen);
    expect(deepen[50]).toBeLessThan(42);
    expect(Math.abs(deepen[200]! - 200)).toBeLessThanOrEqual(1);
  });

  test('contrast, highlights and shadows keep hue', async ({ page }) => {
    const colours: Rgb[] = [
      [240, 200, 150],
      [150, 210, 240],
      [60, 40, 30],
      [30, 50, 80],
    ];
    const image = makeImage(colours.length, 1, (x) => colours[x]!);
    const toneParams = [{ contrast: 1 }, { contrast: -1 }, { highlights: -1 }, { highlights: 1 }, { shadows: 1 }, { shadows: -1 }];
    for (const params of toneParams) {
      const out = await renderLayers(page, image, [layer('adjust', params)]);
      colours.forEach((c, x) => {
        expect(Math.abs(hue(rgbAt(out, x, 0)) - hue(c)), `${JSON.stringify(params)} ${c}`).toBeLessThan(4);
      });
    }
  });

  test('saturation -1 gives neutral greys; +1 adds chroma without leaving the gamut', async ({ page }) => {
    const grey = await renderLayers(page, colourful, [layer('adjust', { saturation: -1 })]);
    for (let i = 0; i < grey.data.length; i += 4) {
      expect(Math.abs(grey.data[i]! - grey.data[i + 1]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(grey.data[i + 1]! - grey.data[i + 2]!)).toBeLessThanOrEqual(1);
    }

    const colours: Rgb[] = [
      [180, 120, 100],
      [90, 140, 200],
      [128, 128, 128],
      [250, 30, 30],
      [235, 45, 45],
    ];
    const image = makeImage(colours.length, 1, (x) => colours[x]!);
    const out = await renderLayers(page, image, [layer('adjust', { saturation: 1 })]);
    expect(chroma(rgbAt(out, 0, 0))).toBeGreaterThan(chroma(colours[0]!) * 1.3);
    expect(chroma(rgbAt(out, 1, 0))).toBeGreaterThan(chroma(colours[1]!) * 1.3);
    expect(Math.abs(hue(rgbAt(out, 0, 0)) - hue(colours[0]!))).toBeLessThan(6);
    expect(Math.abs(hue(rgbAt(out, 1, 0)) - hue(colours[1]!))).toBeLessThan(6);
    expect(rgbAt(out, 2, 0)).toEqual([128, 128, 128]);
    colours.forEach((c, x) => {
      expect(linearLuminance(rgbAt(out, x, 0)) / linearLuminance(c), `${c}`).toBeCloseTo(1, 1);
    });
    // Near-gamut colours are compressed, not clipped onto the same value.
    const [a, b] = [rgbAt(out, 3, 0), rgbAt(out, 4, 0)];
    expect(Math.max(...a.map((v, i) => Math.abs(v - b[i]!)))).toBeGreaterThan(5);
  });

  test('vibrance favours muted colours and protects skin', async ({ page }) => {
    const muted: Rgb = [110, 125, 150];
    const skin: Rgb = [215, 170, 145];
    const vivid: Rgb = [40, 90, 230];
    const image = makeImage(3, 1, (x) => [muted, skin, vivid][x]!);
    const out = await renderLayers(page, image, [layer('adjust', { vibrance: 1 })]);
    const gain = (x: number, c: Rgb) => chroma(rgbAt(out, x, 0)) / chroma(c);
    expect(gain(0, muted)).toBeGreaterThan(1.5);
    expect(gain(0, muted)).toBeGreaterThan(gain(1, skin) + 0.3);
    expect(gain(0, muted)).toBeGreaterThan(gain(2, vivid) + 0.3);
    expect(gain(1, skin)).toBeLessThan(1.3);

    const reduced = await renderLayers(page, image, [layer('adjust', { vibrance: -1 })]);
    expect(chroma(rgbAt(reduced, 0, 0))).toBeLessThan(chroma(muted) * 0.6);
  });

  test('every slider has a monotonic response', async ({ page }) => {
    // Row 0: grey ramp; row 1: a muted blue.
    const probe = makeImage(256, 2, (x, y) => (y === 0 ? [x, x, x] : [110, 125, 150]));
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    const channel = (p: Pixels, y: number, c: number, from: number, to: number) =>
      mean(Array.from({ length: to - from }, (_, i) => pixelAt(p, from + i, y)[c]!));
    const meanChroma = (p: Pixels) => mean(Array.from({ length: 256 }, (_, x) => chroma(rgbAt(p, x, 1))));
    const metrics: Record<keyof LayerParams['adjust'], (p: Pixels) => number> = {
      exposure: (p) => channel(p, 0, 0, 0, 256),
      contrast: (p) => channel(p, 0, 0, 170, 256) - channel(p, 0, 0, 0, 86),
      highlights: (p) => channel(p, 0, 0, 180, 256),
      shadows: (p) => channel(p, 0, 0, 10, 80),
      saturation: meanChroma,
      vibrance: meanChroma,
      temperature: (p) => channel(p, 0, 0, 60, 200) - channel(p, 0, 2, 60, 200),
      tint: (p) => (channel(p, 0, 0, 60, 200) + channel(p, 0, 2, 60, 200)) / 2 - channel(p, 0, 1, 60, 200),
    };
    for (const key of keys) {
      const range = key === 'exposure' ? 2 : 1;
      let previous = -Infinity;
      for (const step of [-1, -0.5, -0.1, 0.1, 0.5, 1]) {
        const value = metrics[key](await renderLayers(page, probe, [layer('adjust', { [key]: step * range })]));
        expect(value, `${key}=${step * range}`).toBeGreaterThan(previous);
        previous = value;
      }
    }
  });

  test('colour sliders leave neutral greys untouched', async ({ page }) => {
    const input = asPixels(greyRamp);
    for (const params of [{ saturation: 1 }, { saturation: -1 }, { vibrance: 1 }, { vibrance: -1 }]) {
      const out = await renderLayers(page, greyRamp, [layer('adjust', params)]);
      expect(maxAbsDiff(out, input), JSON.stringify(params)).toBeLessThanOrEqual(1);
    }
  });

  test('temperature and tint shift white balance while preserving luminance', async ({ page }) => {
    const grey = flat([128, 128, 128]);
    const at = async (params: Partial<LayerParams['adjust']>) =>
      rgbAt(await renderLayers(page, grey, [layer('adjust', params)]), 4, 4);

    const warm = await at({ temperature: 1 });
    const cool = await at({ temperature: -1 });
    expect(warm[0] / warm[2]).toBeGreaterThan(1.15);
    expect(cool[0] / cool[2]).toBeLessThan(1 / 1.15);
    const half = await at({ temperature: 0.5 });
    expect(half[0] / half[2]).toBeGreaterThan(1.05);
    expect(half[0] / half[2]).toBeLessThan(warm[0] / warm[2]);

    const magenta = await at({ tint: 1 });
    const green = await at({ tint: -1 });
    expect(magenta[1]).toBeLessThan(Math.min(magenta[0], magenta[2]));
    expect(green[1]).toBeGreaterThan(Math.max(green[0], green[2]));

    for (const c of [warm, cool, magenta, green]) {
      expect(linearLuminance(c) / toLinear(128)).toBeCloseTo(1, 1);
    }
  });
});

test.describe('filter', () => {
  const identity = buildLut(17, (r, g, b) => [r, g, b]);
  const invert = buildLut(17, (r, g, b) => [1 - r, 1 - g, 1 - b]);
  const customLuts = { identity, invert };
  const filter = (id: string, intensity: number) => layer('filter', { lookId: `custom:${id}`, intensity });

  test('an identity LUT is an identity', async ({ page }) => {
    const out = await render(page, { image: colourful, layers: [filter('identity', 1)], customLuts });
    expect(maxAbsDiff(out, asPixels(colourful))).toBeLessThanOrEqual(1);
  });

  test('an inversion LUT inverts, and intensity blends', async ({ page }) => {
    const full = await render(page, { image: colourful, layers: [filter('invert', 1)], customLuts });
    const half = await render(page, { image: colourful, layers: [filter('invert', 0.5)], customLuts });
    for (let i = 0; i < full.data.length; i++) {
      if (i % 4 === 3) continue;
      expect(Math.abs(full.data[i]! - (255 - colourful.data[i]!))).toBeLessThanOrEqual(1);
      expect(Math.abs(half.data[i]! - 127.5)).toBeLessThanOrEqual(1.5);
    }
  });

  test('an unknown look leaves the image unchanged', async ({ page }) => {
    const out = await render(page, { image: colourful, layers: [filter('missing', 1)], customLuts });
    expect(maxAbsDiff(out, asPixels(colourful))).toBe(0);
  });
});

test.describe('sharpen', () => {
  const edge = makeImage(64, 8, (x) => (x < 32 ? [80, 80, 80] : [170, 170, 170]));

  test('flat areas and tiny amounts are unchanged', async ({ page }) => {
    const flatOut = await renderLayers(page, flat([90, 140, 200]), [layer('sharpen', { amount: 1 })]);
    expect(maxAbsDiff(flatOut, asPixels(flat([90, 140, 200])))).toBeLessThanOrEqual(1);
    const tiny = await renderLayers(page, colourful, [layer('sharpen', { amount: 1e-4 })]);
    expect(maxAbsDiff(tiny, asPixels(colourful))).toBeLessThanOrEqual(1);
  });

  test('edge contrast increases, halos are bounded and greys stay grey', async ({ page }) => {
    const out = await renderLayers(page, edge, [layer('sharpen', { amount: 1, radius: 0.5 })]);
    const [dark] = rgbAt(out, 31, 4);
    const [light] = rgbAt(out, 32, 4);
    expect(dark).toBeLessThan(75);
    expect(light).toBeGreaterThan(175);
    expect(80 - dark).toBeLessThanOrEqual(32);
    expect(light - 170).toBeLessThanOrEqual(32);
    expect(rgbAt(out, 2, 4)).toEqual([80, 80, 80]);
    expect(rgbAt(out, 61, 4)).toEqual([170, 170, 170]);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(out.data[i + 1]);
      expect(out.data[i + 1]).toBe(out.data[i + 2]);
    }
  });

  test('sharpens luminance only: a colour edge gets the same offset on every channel', async ({ page }) => {
    // Channel steps across the edge differ in sign and size (R -170, G -40, B +100),
    // so a per-channel unsharp mask would give each channel a different offset.
    const colourEdge = makeImage(64, 8, (x) => (x < 32 ? [220, 110, 70] : [50, 70, 170]));
    const input = asPixels(colourEdge);
    const out = await renderLayers(page, colourEdge, [layer('sharpen', { amount: 1, radius: 0.5 })]);
    for (let x = 0; x < 64; x++) {
      const delta = rgbAt(out, x, 4).map((v, c) => v - rgbAt(input, x, 4)[c]!);
      expect(Math.max(...delta) - Math.min(...delta), `x=${x} ${delta}`).toBeLessThanOrEqual(1);
    }
    expect(linearLuminance(rgbAt(out, 31, 4))).toBeGreaterThan(linearLuminance(rgbAt(input, 31, 4)) * 1.1);
    expect(linearLuminance(rgbAt(out, 32, 4))).toBeLessThan(linearLuminance(rgbAt(input, 32, 4)) * 0.9);
  });

  test('a larger radius widens the halo', async ({ page }) => {
    const narrow = await renderLayers(page, edge, [layer('sharpen', { amount: 1, radius: 0 })]);
    const wide = await renderLayers(page, edge, [layer('sharpen', { amount: 1, radius: 1 })]);
    expect(pixelAt(narrow, 27, 4)[0]).toBe(80);
    expect(pixelAt(wide, 27, 4)[0]).toBeLessThan(80);
  });
});

test.describe('vignette', () => {
  const grey = flat([180, 180, 180], 64);

  test('darkens the corners but not the centre', async ({ page }) => {
    const out = await renderLayers(page, grey, [layer('vignette', { amount: -1 })]);
    const centre = pixelAt(out, 32, 32)[0];
    expect(Math.abs(centre - 180)).toBeLessThanOrEqual(1);
    const corners = [rgbAt(out, 0, 0), rgbAt(out, 63, 0), rgbAt(out, 0, 63), rgbAt(out, 63, 63)].map((c) => c[0]);
    for (const c of corners) expect(c).toBeLessThan(110);
    expect(Math.max(...corners) - Math.min(...corners)).toBeLessThanOrEqual(1);
    // Monotonic falloff along the diagonal.
    const diagonal = Array.from({ length: 32 }, (_, i) => pixelAt(out, 32 + i, 32 + i)[0]);
    for (let i = 1; i < diagonal.length; i++) expect(diagonal[i]!).toBeLessThanOrEqual(diagonal[i - 1]! + 1);
  });

  test('follows the frame shape: corners match at any aspect ratio', async ({ page }) => {
    const shades = async (width: number, height: number) => {
      const out = await renderLayers(page, makeImage(width, height, () => [180, 180, 180]), [layer('vignette', { amount: -1 })]);
      const corners = [rgbAt(out, 0, 0), rgbAt(out, width - 1, 0), rgbAt(out, 0, height - 1), rgbAt(out, width - 1, height - 1)].map((c) => c[0]);
      return {
        corners,
        centre: pixelAt(out, width >> 1, height >> 1)[0],
        sideMiddle: pixelAt(out, 0, height >> 1)[0],
        topMiddle: pixelAt(out, width >> 1, 0)[0],
      };
    };
    const square = await shades(96, 96);
    const landscape = await shades(128, 64);
    const portrait = await shades(64, 128);
    for (const s of [square, landscape, portrait]) {
      expect(Math.abs(s.centre - 180)).toBeLessThanOrEqual(1);
      expect(Math.max(...s.corners) - Math.min(...s.corners)).toBeLessThanOrEqual(1);
      expect(Math.abs(s.corners[0]! - square.corners[0]!)).toBeLessThanOrEqual(2);
    }
    expect(Math.abs(square.sideMiddle - square.topMiddle)).toBeLessThanOrEqual(1);
    // Not a circle in uv: the edge farther from the centre is darker, yet lighter than the corners.
    expect(landscape.sideMiddle).toBeLessThan(landscape.topMiddle - 10);
    expect(portrait.topMiddle).toBeLessThan(portrait.sideMiddle - 10);
    expect(landscape.sideMiddle).toBeGreaterThan(landscape.corners[0]! + 10);
  });

  test('positive amounts lighten toward white', async ({ page }) => {
    const out = await renderLayers(page, grey, [layer('vignette', { amount: 1 })]);
    expect(Math.abs(pixelAt(out, 32, 32)[0] - 180)).toBeLessThanOrEqual(1);
    expect(pixelAt(out, 0, 0)[0]).toBeGreaterThan(235);
  });

  test('midpoint moves the start of the falloff', async ({ page }) => {
    const early = await renderLayers(page, grey, [layer('vignette', { amount: -1, midpoint: 0.1 })]);
    const late = await renderLayers(page, grey, [layer('vignette', { amount: -1, midpoint: 0.8 })]);
    expect(pixelAt(early, 48, 48)[0]).toBeLessThan(pixelAt(late, 48, 48)[0] - 20);
  });

  test('a tiny amount stays within 1 LSB', async ({ page }) => {
    const out = await renderLayers(page, colourful, [layer('vignette', { amount: -1e-4 })]);
    expect(maxAbsDiff(out, asPixels(colourful))).toBeLessThanOrEqual(1);
  });
});

test.describe('grain', () => {
  const grey = flat([128, 128, 128], 256);

  test('adds deterministic, zero-mean luminance grain', async ({ page }) => {
    const a = await grainOnGrey(page, 128, { amount: 1, size: 0.3 });
    const b = await grainOnGrey(page, 128, { amount: 1, size: 0.3 });
    expect(meanAbsDiff(a, b)).toBe(0);
    expect(meanAbsDiff(a, grey)).toBeGreaterThan(3);
    expect(Math.abs(meanLuma(a) - 128)).toBeLessThan(2);
    let coloured = 0;
    for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== a.data[i + 1] || a.data[i + 1] !== a.data[i + 2]) coloured++;
    expect(coloured, 'pixels that are not grey').toBe(0);
  });

  test('is strongest in the midtones', async ({ page }) => {
    const deviation = async (v: number) => meanAbsDiff(await grainOnGrey(page, v, { amount: 1 }), flat([v, v, v], 256));
    const mid = await deviation(128);
    expect(mid).toBeGreaterThan(2 * (await deviation(20)));
    expect(mid).toBeGreaterThan(2 * (await deviation(240)));
  });

  test('a tiny amount stays within 1 LSB', async ({ page }) => {
    const out = await renderLayers(page, colourful, [layer('grain', { amount: 1e-3 })]);
    expect(maxAbsDiff(out, asPixels(colourful))).toBeLessThanOrEqual(1);
  });

  test('is isotropic, with no visible grain-cell lattice', async ({ page }) => {
    // size 1 = 4 px cells at the reference diagonal: texture must not vary with the position inside a cell.
    const out = await grainOnGrey(page, 128, { amount: 1, size: 1 });
    const horizontal = neighbourEnergyByPhase(out, 'x', 4);
    const vertical = neighbourEnergyByPhase(out, 'y', 4);
    for (const energy of [horizontal, vertical]) {
      expect(Math.max(...energy) / Math.min(...energy), energy.join(' ')).toBeLessThan(1.3);
    }
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    expect(mean(horizontal) / mean(vertical)).toBeGreaterThan(0.85);
    expect(mean(horizontal) / mean(vertical)).toBeLessThan(1.15);
  });

  test('size sets the grain scale', async ({ page }) => {
    const fine = await grainOnGrey(page, 128, { amount: 1, size: 0 });
    const coarse = await grainOnGrey(page, 128, { amount: 1, size: 1 });
    expect(lagOneCorrelation(coarse)).toBeGreaterThan(lagOneCorrelation(fine) + 0.3);
    expect(lagOneCorrelation(fine)).toBeLessThan(0.6);
  });

  test('looks the same on photos of any resolution shown at the same size', async ({ page }) => {
    // The same quarter of an 800 x 600 photo exported and of a 3200 x 2400 photo previewed at 1/4.
    const quarter = layer('transform', { crop: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 } });
    const effect = layer('grain', { amount: 1, size: 0.3 });
    const small = await renderLayers(page, greyPhoto(128, { width: 800, height: 600 }), [effect, quarter]);
    const large = await renderLayers(page, greyPhoto(128, { width: 3200, height: 2400 }), [effect, quarter], 200);
    expect([large.width, large.height]).toEqual([small.width, small.height]);
    const ratio = standardDeviation(redOffsets(large, 128)) / standardDeviation(redOffsets(small, 128));
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
    expect(Math.abs(lagOneCorrelation(large) - lagOneCorrelation(small))).toBeLessThan(0.1);
  });
});

test.describe('transform', () => {
  // A B C
  // D E F
  const letters: Record<string, Rgb> = {
    A: [255, 0, 0],
    B: [0, 255, 0],
    C: [0, 0, 255],
    D: [255, 255, 0],
    E: [0, 255, 255],
    F: [255, 0, 255],
  };
  const pattern = makeImage(3, 2, (x, y) => letters['ABCDEF'[y * 3 + x]!]!);

  async function readLetters(page: Page, params: Partial<LayerParams['transform']>) {
    const out = await renderLayers(page, pattern, [layer('transform', params)]);
    const rows: string[] = [];
    for (let y = 0; y < out.height; y++) {
      let row = '';
      for (let x = 0; x < out.width; x++) {
        const c = rgbAt(out, x, y);
        row += Object.keys(letters).find((k) => letters[k]!.every((v, i) => v === c[i])) ?? '?';
      }
      rows.push(row);
    }
    return rows;
  }

  test('rotations and flips move pixels exactly', async ({ page }) => {
    expect(await readLetters(page, { rotate: 90 })).toEqual(['DA', 'EB', 'FC']);
    expect(await readLetters(page, { rotate: 180 })).toEqual(['FED', 'CBA']);
    expect(await readLetters(page, { rotate: 270 })).toEqual(['CF', 'BE', 'AD']);
    expect(await readLetters(page, { flipH: true })).toEqual(['CBA', 'FED']);
    expect(await readLetters(page, { flipV: true })).toEqual(['DEF', 'ABC']);
    // Flip applies after rotation.
    expect(await readLetters(page, { rotate: 90, flipH: true })).toEqual(['AD', 'BE', 'CF']);
    expect(await readLetters(page, { rotate: 90, flipV: true })).toEqual(['FC', 'EB', 'DA']);
  });

  /** Pixel value encodes its source coordinate. */
  const coords = makeImage(10, 6, (x, y) => [x * 20, y * 40, 77]);

  /** Independent CPU reference: forward-map every source pixel, then crop. */
  function reference(params: LayerParams['transform']): Pixels {
    const { width: w, height: h } = coords;
    const swap = params.rotate === 90 || params.rotate === 270;
    const rw = swap ? h : w;
    const rh = swap ? w : h;
    const rotated = new Uint8ClampedArray(rw * rh * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let [tx, ty] =
          params.rotate === 90 ? [h - 1 - y, x] : params.rotate === 180 ? [w - 1 - x, h - 1 - y] : params.rotate === 270 ? [y, w - 1 - x] : [x, y];
        if (params.flipH) tx = rw - 1 - tx;
        if (params.flipV) ty = rh - 1 - ty;
        for (let c = 0; c < 4; c++) rotated[(ty * rw + tx) * 4 + c] = coords.data[(y * w + x) * 4 + c]!;
      }
    }
    const crop = params.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const cw = Math.max(1, Math.round(rw * crop.width));
    const ch = Math.max(1, Math.round(rh * crop.height));
    const x0 = Math.round(rw * crop.x);
    const y0 = Math.round(rh * crop.y);
    const data = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        for (let c = 0; c < 4; c++) data[(y * cw + x) * 4 + c] = rotated[((y0 + y) * rw + x0 + x) * 4 + c]!;
      }
    }
    return { width: cw, height: ch, data };
  }

  test('crop selects exact pixels in the rotated and flipped space', async ({ page }) => {
    const crop = { x: 0.2, y: 1 / 6, width: 0.5, height: 0.5 };
    const out = await renderLayers(page, coords, [layer('transform', { crop })]);
    expect([out.width, out.height]).toEqual([5, 3]);
    expect(rgbAt(out, 0, 0)).toEqual([40, 40, 77]);
    expect(rgbAt(out, 4, 2)).toEqual([120, 120, 77]);

    for (const rotate of [0, 90, 180, 270] as const) {
      for (const [flipH, flipV] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        for (const c of [null, { x: 0.25, y: 0.1, width: 0.6, height: 0.7 }, { x: 0, y: 0.5, width: 0.01, height: 0.5 }]) {
          const params = { rotate, flipH, flipV, crop: c };
          const expected = reference(params);
          const got = await renderLayers(page, coords, [layer('transform', params)]);
          const label = JSON.stringify(params);
          expect([got.width, got.height], label).toEqual([expected.width, expected.height]);
          expect(maxAbsDiff(got, expected), label).toBe(0);
        }
      }
    }
  });

  test('output size swaps for quarter turns and rounds the crop', async ({ page }) => {
    const crop = { x: 0, y: 0, width: 0.55, height: 0.34 };
    const sizes: Record<number, [number, number]> = { 0: [6, 2], 90: [3, 3], 180: [6, 2], 270: [3, 3] };
    for (const rotate of [0, 90, 180, 270] as const) {
      const out = await renderLayers(page, coords, [layer('transform', { rotate, crop })]);
      expect([out.width, out.height], `rotate ${rotate}`).toEqual(sizes[rotate]);
      const plain = await renderLayers(page, coords, [layer('transform', { rotate })]);
      expect([plain.width, plain.height]).toEqual(rotate % 180 === 0 ? [10, 6] : [6, 10]);
    }
  });

  test('a full-frame crop is an exact identity', async ({ page }) => {
    const out = await renderLayers(page, coords, [layer('transform', { crop: { x: 0, y: 0, width: 1, height: 1 } })]);
    expect(maxAbsDiff(out, asPixels(coords))).toBe(0);
  });
});

test.describe('resolution independence', () => {
  // Smooth gradients, hard-edged shapes and stripes, so both tone and detail effects show up.
  const scene = makeImage(256, 256, (x, y) => {
    const inDisc = (x - 90) ** 2 + (y - 100) ** 2 < 40 ** 2;
    const inBox = x > 150 && x < 220 && y > 140 && y < 210;
    const inStripes = x >= 16 && x < 128 && y >= 160 && y < 240;
    if (inDisc) return [220, 180, 150];
    if (inBox) return [40, 70, 120];
    if (inStripes) return (x >> 3) % 2 ? [70, 75, 80] : [180, 170, 160];
    return [60 + (x >> 1), 90 + (y >> 2), 140 - (x >> 2)];
  });
  const original = asPixels(scene);

  const cases: [string, AnyLayer][] = [
    ['vignette', layer('vignette', { amount: -0.8 })],
    ['sharpen', layer('sharpen', { amount: 1, radius: 0.5 })],
  ];

  function expectPreviewMatchesExport(preview: Pixels, full: Pixels, original: Pixels) {
    expect([preview.width, preview.height]).toEqual([full.width, full.height]);
    const strength = meanAbsDiff(full, original);
    const mismatch = meanAbsDiff(preview, full);
    expect(strength, 'effect is visible').toBeGreaterThan(0.5);
    expect(mismatch).toBeLessThan(strength * 0.2);
  }

  for (const [name, effect] of cases) {
    test(`${name} preview matches the downsampled export`, async ({ page }) => {
      const full = downsample(await renderLayers(page, scene, [effect]), 2);
      const preview = await renderLayers(page, scene, [effect], 128);
      expectPreviewMatchesExport(preview, full, downsample(original, 2));
    });
  }

  test('grain preview matches the downsampled export', async ({ page }) => {
    // Grain cells follow the photo's diagonal, so use a photo large enough to resolve them: the scene
    // scaled to 2048 px, cropped to its central 512 px.
    const photo: HarnessImage = { ...scene, resize: { width: 2048, height: 2048 } };
    const centre = layer('transform', { crop: { x: 0.375, y: 0.375, width: 0.25, height: 0.25 } });
    const effect = layer('grain', { amount: 1, size: 1 });
    const full = downsample(await renderLayers(page, photo, [effect, centre]), 2);
    const preview = await renderLayers(page, photo, [effect, centre], 256);
    expectPreviewMatchesExport(preview, full, downsample(await renderLayers(page, photo, [centre]), 2));
  });

  test('fine grain in a preview is as strong as in the downsampled export', async ({ page }) => {
    // Grain finer than a preview pixel cannot match pixel for pixel, but its strength must.
    for (const size of [0, 0.5]) {
      const full = await grainOnGrey(page, 128, { amount: 1, size });
      for (const factor of [2, 4]) {
        const preview = await grainOnGrey(page, 128, { amount: 1, size }, 256 / factor);
        const ratio = standardDeviation(redOffsets(preview, 128)) / standardDeviation(redOffsets(downsample(full, factor), 128));
        expect(ratio, `size ${size}, 1/${factor}`).toBeGreaterThan(0.85);
        expect(ratio, `size ${size}, 1/${factor}`).toBeLessThan(1.15);
      }
    }
  });
});
