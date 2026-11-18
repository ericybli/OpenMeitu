import { describe, expect, it } from 'vitest';
import { hueDifference, linearToSrgb, luminance, oklabToOklch, rgbToOklab, type Rgb } from '../../src/filters/color';
import { sampleLut } from '../../src/filters/cube';
import { getLook, getLookTransform, listLooks, type Look, type LookCategory } from '../../src/filters/looks';
import { DEFAULT_LUT_SIZE, identityLut, type LutData } from '../../src/filters/lut';

const REQUIRED_IDS = [
  'original',
  'natural',
  'fresh',
  'warm',
  'cool',
  'film',
  'film-fade',
  'portrait-soft',
  'rosy',
  'japanese',
  'vivid',
  'cinematic',
  'retro',
  'mono',
  'mono-contrast',
  'sepia',
];
const CATEGORIES: readonly LookCategory[] = ['natural', 'portrait', 'film', 'vivid', 'mono', 'creative'];
const MONO_IDS = ['mono', 'mono-contrast'];
const MONOCHROME_IDS = [...MONO_IDS, 'sepia'];
const COLOUR_LOOKS = listLooks().filter((l) => !MONOCHROME_IDS.includes(l.id));

/** Light to deep complexions, in shadow and highlight (sRGB). */
const SKIN_TONES: Rgb[] = [
  [0.87, 0.67, 0.56],
  [0.96, 0.82, 0.74],
  [0.95, 0.78, 0.74],
  [0.78, 0.57, 0.45],
  [0.55, 0.38, 0.3],
  [0.45, 0.3, 0.22],
  [0.98, 0.88, 0.8],
];

/** Deterministic, well-spread sample of the RGB cube (additive recurrence with irrational steps). */
const SAMPLES: Rgb[] = Array.from({ length: 3000 }, (_, i) => [
  (i * 0.6180339887) % 1,
  (i * 0.4142135624) % 1,
  (i * 0.7320508076) % 1,
]);

/** Bright colours with a clipped channel, as in blown-out highlights. */
const CLIPPED: Rgb[] = [
  [1, 1, 0],
  [1, 0.75, 0],
  [1, 0.45, 0],
  [0, 1, 1],
  [0, 1, 0.6],
  [1, 0, 1],
  [1, 1, 0.4],
  [1, 0.85, 0.2],
  [0.35, 1, 0.85],
  [0, 0.55, 1],
];

const builtLuts = new Map<string, LutData>();

/** The look's LUT at the default size, built once per test run. */
function lutOf(look: Look): LutData {
  let lut = builtLuts.get(look.id);
  if (!lut) {
    lut = look.build();
    builtLuts.set(look.id, lut);
  }
  return lut;
}

function transformOf(id: string) {
  const fn = getLookTransform(id);
  if (!fn) throw new Error(`no transform for ${id}`);
  return fn;
}

function lch(c: Rgb): Rgb {
  return oklabToOklch(rgbToOklab(c));
}

function clampRgb(c: Rgb): Rgb {
  return [Math.min(1, Math.max(0, c[0])), Math.min(1, Math.max(0, c[1])), Math.min(1, Math.max(0, c[2]))];
}

function deltaE(a: Rgb, b: Rgb): number {
  const la = rgbToOklab(a);
  const lb = rgbToOklab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

describe('look catalogue', () => {
  it('provides every required look with English and Chinese names and a category', () => {
    for (const id of REQUIRED_IDS) {
      const look = getLook(id);
      expect(look, id).toBeDefined();
      expect(look!.id).toBe(id);
      expect(look!.name.en.trim().length).toBeGreaterThan(0);
      expect(look!.name.zh).toMatch(/^\p{Script=Han}+$/u);
      expect(CATEGORIES).toContain(look!.category);
    }
  });

  it('has unique ids and names', () => {
    const looks = listLooks();
    expect(new Set(looks.map((l) => l.id)).size).toBe(looks.length);
    expect(new Set(looks.map((l) => l.name.en)).size).toBe(looks.length);
    expect(new Set(looks.map((l) => l.name.zh)).size).toBe(looks.length);
  });

  it('files monochrome looks under the mono category', () => {
    for (const id of MONOCHROME_IDS) expect(getLook(id)!.category).toBe('mono');
  });

  it('returns undefined for unknown ids', () => {
    expect(getLook('does-not-exist')).toBeUndefined();
    expect(getLookTransform('does-not-exist')).toBeUndefined();
  });
});

describe('LUT building', () => {
  it("builds 'original' as the exact identity at any size", () => {
    for (const size of [2, 17, DEFAULT_LUT_SIZE]) {
      expect(getLook('original')!.build(size).data).toEqual(identityLut(size).data);
    }
    expect(getLook('original')!.build().data).toEqual(identityLut().data);
  });

  it('builds deterministically at the requested size with opaque alpha', () => {
    for (const look of listLooks()) {
      const a = look.build(9);
      const b = look.build(9);
      expect(a.size).toBe(9);
      expect(a.data.length).toBe(9 ** 3 * 4);
      expect(a.data).toEqual(b.data);
      for (let i = 3; i < a.data.length; i += 4) expect(a.data[i]).toBe(255);
    }
  });

  it('defaults to DEFAULT_LUT_SIZE', () => {
    expect(getLook('film')!.build().size).toBe(DEFAULT_LUT_SIZE);
  });

  it('transforms produce finite values everywhere in the cube', () => {
    for (const look of listLooks()) {
      const fn = transformOf(look.id);
      for (const c of SAMPLES) for (const v of fn(c[0], c[1], c[2])) expect(Number.isFinite(v), look.id).toBe(true);
      for (const v of fn(0, 0, 0).concat(fn(1, 1, 1))) expect(Number.isFinite(v), look.id).toBe(true);
    }
  });

  it('LUTs reproduce their transforms within a just-noticeable difference', () => {
    for (const look of listLooks()) {
      const fn = transformOf(look.id);
      const lut = lutOf(look);
      let sum = 0;
      for (const c of SAMPLES) {
        const d = deltaE(clampRgb(fn(c[0], c[1], c[2])), sampleLut(lut, c[0], c[1], c[2]));
        expect(d, `${look.id} at ${c.join(',')}`).toBeLessThan(0.04);
        sum += d;
      }
      expect(sum / SAMPLES.length, look.id).toBeLessThan(0.002);
    }
  });
});

describe('monochrome looks', () => {
  it('mono looks output r = g = b for every LUT entry', () => {
    for (const id of MONO_IDS) {
      const { data } = getLook(id)!.build();
      for (let i = 0; i < data.length; i += 4) {
        expect(data[i], id).toBe(data[i + 1]);
        expect(data[i + 1], id).toBe(data[i + 2]);
      }
    }
  });

  it('sepia depends only on luminance and is warm-toned', () => {
    const sepia = transformOf('sepia');
    for (const c of SAMPLES.slice(0, 300)) {
      const v = linearToSrgb(luminance(c));
      const [r, g, b] = sepia(c[0], c[1], c[2]);
      const grey = sepia(v, v, v);
      expect(r).toBeCloseTo(grey[0], 6);
      expect(g).toBeCloseTo(grey[1], 6);
      expect(b).toBeCloseTo(grey[2], 6);
    }
    const { data } = getLook('sepia')!.build();
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i]).toBeGreaterThanOrEqual(data[i + 1]!);
      expect(data[i + 1]).toBeGreaterThanOrEqual(data[i + 2]!);
    }
  });
});

describe('photographic sanity', () => {
  it('keeps skin tones natural in every colour look, both in its maths and through its LUT', () => {
    for (const look of COLOUR_LOOKS) {
      const fn = transformOf(look.id);
      const lut = lutOf(look);
      for (const skin of SKIN_TONES) {
        const [L0, C0, h0] = lch(skin);
        const outputs: [string, Rgb][] = [
          ['transform', fn(skin[0], skin[1], skin[2])],
          ['LUT', sampleLut(lut, skin[0], skin[1], skin[2])],
        ];
        for (const [path, out] of outputs) {
          const [L, C, h] = lch(out);
          const where = `${look.id} (${path}) on ${skin.join(',')}`;
          // Still a skin hue: between rosy red and golden yellow, never green or magenta.
          expect(h, where).toBeGreaterThan(20);
          expect(h, where).toBeLessThan(80);
          expect(Math.abs(hueDifference(h0, h)), where).toBeLessThan(20);
          expect(C / C0, where).toBeGreaterThan(0.5);
          expect(C / C0, where).toBeLessThan(1.6);
          expect(Math.abs(L - L0), where).toBeLessThan(0.12);
          expect(Math.max(...out), where).toBeLessThan(0.9995);
        }
      }
    }
  });

  it('does not wash out clipped bright colours more than the same colours just below clipping', () => {
    // A look may desaturate everything, but clipped highlights (a blown-out yellow
    // or cyan) must not turn paler than their unclipped surroundings.
    const chroma = (c: Rgb) => lch(c)[1];
    for (const look of COLOUR_LOOKS) {
      const lut = lutOf(look);
      for (const c of CLIPPED) {
        const inside: Rgb = [c[0] * 0.94, c[1] * 0.94, c[2] * 0.94];
        const faceRatio = chroma(sampleLut(lut, c[0], c[1], c[2])) / chroma(c);
        const insideRatio = chroma(sampleLut(lut, inside[0], inside[1], inside[2])) / chroma(inside);
        expect(faceRatio, `${look.id} on ${c.join(',')}`).toBeGreaterThan(0.9 * Math.min(1, insideRatio));
      }
    }
  });

  it('keeps tonal order along the grey axis', () => {
    for (const look of listLooks()) {
      const fn = transformOf(look.id);
      let prev = -Infinity;
      for (let i = 0; i <= 128; i++) {
        const v = i / 128;
        const L = rgbToOklab(clampRgb(fn(v, v, v)))[0];
        expect(L, `${look.id} at ${v}`).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = L;
      }
    }
  });

  it('keeps highlight detail and does not crush or wash out blacks', () => {
    const L = (fn: ReturnType<typeof transformOf>, v: number) => rgbToOklab(clampRgb(fn(v, v, v)))[0];
    const inputSpan = rgbToOklab([1, 1, 1])[0] - rgbToOklab([0.9, 0.9, 0.9])[0];
    for (const look of listLooks()) {
      const fn = transformOf(look.id);
      expect((L(fn, 1) - L(fn, 0.9)) / inputSpan, look.id).toBeGreaterThan(0.35);
      expect(L(fn, 0.1) - L(fn, 0), look.id).toBeGreaterThan(0.05);
      expect(Math.max(...fn(0, 0, 0)), look.id).toBeLessThan(0.15);
      expect(Math.max(...clampRgb(fn(0.9, 0.9, 0.9))), look.id).toBeLessThan(0.999);
    }
  });
});
