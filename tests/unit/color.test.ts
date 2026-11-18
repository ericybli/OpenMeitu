import { describe, expect, it } from 'vitest';
import {
  applyCurves,
  channelMixer,
  clamp01,
  contrast,
  fade,
  hslToRgb,
  hueDifference,
  linearSrgbToOklab,
  linearToSrgb,
  luminance,
  monotoneCurve,
  oklabToLinearSrgb,
  oklabToOklch,
  oklabToRgbInGamut,
  oklabTowardsInGamut,
  oklchToOklab,
  protectColor,
  rgbToHsl,
  rgbToOklab,
  saturation,
  scaleChroma,
  skinToneWeight,
  smoothstep,
  splitTone,
  srgbToLinear,
  vibrance,
  whiteBalance,
  type Rgb,
} from '../../src/filters/color';

const LEVELS = [0, 0.1, 0.35, 0.6, 0.85, 1];
const GRID: Rgb[] = LEVELS.flatMap((r) => LEVELS.flatMap((g) => LEVELS.map((b): Rgb => [r, g, b])));

const SKIN_TONES: Record<string, Rgb> = {
  typical: [0.87, 0.67, 0.56],
  fair: [0.96, 0.82, 0.74],
  medium: [0.78, 0.57, 0.45],
  deep: [0.45, 0.3, 0.22],
};

function expectRgbClose(actual: Rgb, expected: Rgb, digits = 6): void {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i]!, digits);
}

function lch(c: Rgb): Rgb {
  return oklabToOklch(rgbToOklab(c));
}

function expectInGamut(c: Rgb): void {
  for (const v of c) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  }
}

function deltaE(a: Rgb, b: Rgb): number {
  const la = rgbToOklab(a);
  const lb = rgbToOklab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

/** Rounds to 8 bits, as a LUT stores it. */
function to8bit(c: Rgb): number[] {
  return c.map((v) => Math.round(v * 255));
}

/** Bright, clipped colours on the surface of the sRGB cube (highlights a camera blew out). */
const CLIPPED: Rgb[] = [
  [1, 1, 0],
  [1, 0.6, 0],
  [0, 1, 1],
  [1, 0, 1],
  [1, 1, 0.4],
  [0.35, 1, 0.85],
];

describe('helpers', () => {
  it('clamp01 and smoothstep behave as documented', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.4)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0.2, 0.4, 0.1)).toBe(0);
    expect(smoothstep(0.2, 0.4, 0.5)).toBe(1);
  });

  it('hueDifference takes the shorter signed arc', () => {
    expect(hueDifference(350, 10)).toBeCloseTo(20, 9);
    expect(hueDifference(10, 350)).toBeCloseTo(-20, 9);
    expect(hueDifference(90, 90)).toBeCloseTo(0, 9);
    expect(Math.abs(hueDifference(0, 180))).toBeCloseTo(180, 9);
  });
});

describe('sRGB transfer and luminance', () => {
  it('matches IEC 61966-2-1 reference values', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 6);
    expect(linearToSrgb(0.18)).toBeCloseTo(0.461356, 6);
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 12);
  });

  it('is continuous at the piecewise breakpoint', () => {
    const below = srgbToLinear(0.04045);
    const above = Math.pow((0.04045 + 1e-9 + 0.055) / 1.055, 2.4);
    expect(Math.abs(above - below)).toBeLessThan(1e-7);
  });

  it('round-trips encoded values', () => {
    for (let i = 0; i <= 100; i++) expect(linearToSrgb(srgbToLinear(i / 100))).toBeCloseTo(i / 100, 12);
  });

  it('computes relative luminance with BT.709 weights in linear light', () => {
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([1, 1, 1])).toBeCloseTo(1, 12);
    expect(luminance([0.5, 0.5, 0.5])).toBeCloseTo(srgbToLinear(0.5), 12);
    expect(luminance([0, 1, 0])).toBeCloseTo(0.7152, 12);
    expect(luminance([1, 0, 0])).toBeGreaterThan(luminance([0, 0, 1]));
  });
});

describe('HSL', () => {
  it('converts primaries and greys', () => {
    expectRgbClose(rgbToHsl([1, 0, 0]), [0, 1, 0.5]);
    expectRgbClose(rgbToHsl([0, 1, 0]), [1 / 3, 1, 0.5]);
    expectRgbClose(rgbToHsl([0, 0, 1]), [2 / 3, 1, 0.5]);
    expectRgbClose(rgbToHsl([0.4, 0.4, 0.4]), [0, 0, 0.4]);
    expectRgbClose(hslToRgb([0.5, 1, 0.5]), [0, 1, 1]);
  });

  it('round-trips every grid colour', () => {
    for (const c of GRID) expectRgbClose(hslToRgb(rgbToHsl(c)), c, 9);
  });
});

describe('OKLab', () => {
  it('maps white to L = 1 with no chroma', () => {
    expectRgbClose(rgbToOklab([1, 1, 1]), [1, 0, 0], 6);
  });

  it("matches Ottosson's published value for sRGB red", () => {
    expectRgbClose(rgbToOklab([1, 0, 0]), [0.627955, 0.224863, 0.125846], 5);
  });

  it('round-trips linear sRGB', () => {
    for (const c of GRID) expectRgbClose(oklabToLinearSrgb(linearSrgbToOklab(c)), c, 6);
  });

  it('round-trips OKLCh and reports hue in 0..360', () => {
    for (const c of GRID) {
      const lab = rgbToOklab(c);
      const polar = oklabToOklch(lab);
      expect(polar[2]).toBeGreaterThanOrEqual(0);
      expect(polar[2]).toBeLessThan(360);
      expectRgbClose(oklchToOklab(polar), lab, 9);
    }
  });

  it('gamut-maps by reducing chroma at constant lightness and hue', () => {
    for (const c of GRID) expectRgbClose(oklabToRgbInGamut(rgbToOklab(c)), c, 5);

    const target = oklchToOklab([0.7, 0.4, 50]);
    const mapped = oklabToRgbInGamut(target);
    expectInGamut(mapped);
    const [L, C, h] = lch(mapped);
    expect(L).toBeCloseTo(0.7, 3);
    expect(C).toBeLessThan(0.4);
    expect(Math.abs(hueDifference(50, h))).toBeLessThan(0.5);

    expectRgbClose(oklabToRgbInGamut([1.2, 0.1, 0.1]), [1, 1, 1], 4);
    expectRgbClose(oklabToRgbInGamut([-0.1, 0.1, 0]), [0, 0, 0], 4);
  });

  it('oklabTowardsInGamut returns in-gamut targets and otherwise stops where the segment leaves the gamut', () => {
    const from = rgbToOklab([0.5, 0.5, 0.5]);
    expectRgbClose(oklabTowardsInGamut(from, rgbToOklab([0.6, 0.4, 0.3])), [0.6, 0.4, 0.3], 6);

    const to = oklchToOklab([0.75, 0.4, 50]);
    const lab = rgbToOklab(oklabTowardsInGamut(from, to));
    const t = (lab[0] - from[0]) / (to[0] - from[0]);
    expect(t).toBeGreaterThan(0.05);
    expect(t).toBeLessThan(1);
    for (let i = 0; i < 3; i++) expect(lab[i]).toBeCloseTo(from[i]! + t * (to[i]! - from[i]!), 4);
    const further = oklabToLinearSrgb([0, 1, 2].map((i) => from[i]! + (t + 0.01) * (to[i]! - from[i]!)) as unknown as Rgb);
    expect(further.some((v) => v < 0 || v > 1)).toBe(true);
  });

  it('oklabTowardsInGamut keeps colours on the gamut surface instead of paling them', () => {
    for (const c of CLIPPED) {
      const [L, a, b] = rgbToOklab(c);
      expect(deltaE(oklabTowardsInGamut([L, a, b], [L, a * 1.3, b * 1.3]), c)).toBeLessThan(0.002);
    }
    expect(to8bit(oklabTowardsInGamut([1, 0, 0], [1, 0.05, 0.05]))).toEqual([255, 255, 255]);
    expect(to8bit(oklabTowardsInGamut([0, 0, 0], [0, -0.05, 0.05]))).toEqual([0, 0, 0]);
  });
});

describe('monotoneCurve (Fritsch–Carlson)', () => {
  const dense = (curve: (x: number) => number, from = 0, to = 1, steps = 2000): number[] =>
    Array.from({ length: steps + 1 }, (_, i) => curve(from + ((to - from) * i) / steps));

  it('passes through its control points', () => {
    const points = [[0, 0.05], [0.3, 0.2], [0.55, 0.62], [1, 0.97]] as const;
    const curve = monotoneCurve(points);
    for (const [x, y] of points) expect(curve(x)).toBeCloseTo(y, 12);
  });

  it('is the identity for collinear identity points', () => {
    const curve = monotoneCurve([[0, 0], [0.4, 0.4], [1, 1]]);
    for (const x of [0, 0.1, 0.33, 0.5, 0.77, 1]) expect(curve(x)).toBeCloseTo(x, 12);
  });

  it('stays monotone without overshoot on data that makes ordinary cubic splines ring', () => {
    const points = [[0, 0], [0.1, 0.01], [0.2, 0.9], [0.3, 0.92], [0.6, 0.92], [1, 1]] as const;
    const curve = monotoneCurve(points);
    const ys = dense(curve);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(-1e-12);
    for (let k = 0; k < points.length - 1; k++) {
      const [x0, y0] = points[k]!;
      const [x1, y1] = points[k + 1]!;
      for (const y of dense(curve, x0, x1, 200)) {
        expect(y).toBeGreaterThanOrEqual(Math.min(y0, y1) - 1e-12);
        expect(y).toBeLessThanOrEqual(Math.max(y0, y1) + 1e-12);
      }
    }
    for (const y of dense(curve, 0.3, 0.6, 100)) expect(y).toBeCloseTo(0.92, 12);
  });

  it('preserves decreasing data', () => {
    const ys = dense(monotoneCurve([[0, 1], [0.2, 0.95], [0.5, 0.3], [1, 0]]));
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeLessThanOrEqual(1e-12);
  });

  it('holds its end values outside the control range', () => {
    const curve = monotoneCurve([[0.1, 0.2], [0.9, 0.8]]);
    expect(curve(-1)).toBe(0.2);
    expect(curve(0)).toBe(0.2);
    expect(curve(1)).toBe(0.8);
    expect(curve(0.5)).toBeCloseTo(0.5, 12);
  });

  it('rejects invalid control points', () => {
    expect(() => monotoneCurve([[0, 0]])).toThrow(/at least two/);
    expect(() => monotoneCurve([[0, 0], [0, 1]])).toThrow(/strictly increasing/);
    expect(() => monotoneCurve([[0.5, 0], [0.2, 1]])).toThrow(/strictly increasing/);
    expect(() => monotoneCurve([[0, 0], [1, Number.NaN]])).toThrow(/not finite/);
  });
});

describe('applyCurves', () => {
  it('applies the master curve before the channel curves', () => {
    const half = monotoneCurve([[0, 0], [1, 0.5]]);
    const lift = monotoneCurve([[0, 0.25], [1, 1.25]]);
    expectRgbClose(applyCurves([0.8, 0.4, 0.2], { master: half, r: lift }), [0.65, 0.2, 0.1], 12);
    expectRgbClose(applyCurves([0.8, 0.4, 0.2], {}), [0.8, 0.4, 0.2], 12);
  });
});

describe('contrast', () => {
  it('is the identity at 0 and keeps black, mid-grey and white fixed', () => {
    for (const c of GRID) expectRgbClose(contrast(c, 0), c, 12);
    for (const k of [-1, -0.4, 0.3, 1]) expectRgbClose(contrast([0, 0.5, 1], k), [0, 0.5, 1], 12);
  });

  it('steepens mid-tones for positive amounts and flattens them for negative ones', () => {
    const slope = (k: number) => (contrast([0.51, 0.51, 0.51], k)[0] - contrast([0.49, 0.49, 0.49], k)[0]) / 0.02;
    expect(slope(0.4)).toBeCloseTo(1.2, 3);
    expect(slope(-0.4)).toBeCloseTo(0.8, 3);
  });

  it('is monotone over the full amount range, including out-of-range intermediates', () => {
    for (const k of [-1, -0.5, 0.5, 1, 3]) {
      let prev = -Infinity;
      for (let i = -256; i <= 768; i++) {
        const y = contrast([i / 512, 0, 0], k)[0];
        expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = y;
      }
    }
    expect(contrast([1.5, -0.5, 1], 0.4)).toEqual([1.3, -0.3, 1]);
  });
});

describe('fade', () => {
  it('lifts black to the amount, keeps white and stays monotone, including out-of-range intermediates', () => {
    expectRgbClose(fade([0, 1, 0.5], 0), [0, 1, 0.5], 12);
    expectRgbClose(fade([0, 1, 0.5], 0.1), [0.1, 1, 0.525], 12);
    let prev = -Infinity;
    for (let i = -128; i <= 384; i++) {
      const y = fade([i / 256, 0, 0], 0.45)[0];
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
    expectRgbClose(fade([-0.5, 1.5, 1], 0.2), [-0.1, 1.5, 1], 12);
  });
});

describe('scaleChroma', () => {
  const muted: Rgb = [0.55, 0.45, 0.35];

  it('scales chroma exactly when reducing, and when boosting colours far from the gamut boundary', () => {
    const [L0, C0, h0] = lch(muted);
    for (const k of [0, 0.4, 1, 1.2]) {
      const [L, C, h] = lch(scaleChroma(muted, k));
      expect(L).toBeCloseTo(L0, 6);
      expect(C).toBeCloseTo(C0 * k, 6);
      if (k > 0) expect(Math.abs(hueDifference(h0, h))).toBeLessThan(1e-3);
    }
  });

  it('never lowers chroma, shifts lightness or hue, or leaves the gamut when boosting', () => {
    for (const k of [1.1, 1.5, 3]) {
      for (const c of [...GRID, ...CLIPPED]) {
        const out = scaleChroma(c, k);
        expectInGamut(out);
        const [L0, C0, h0] = lch(c);
        const [L, C, h] = lch(out);
        expect(C).toBeGreaterThanOrEqual(C0 - 1e-5);
        expect(L).toBeCloseTo(L0, 4);
        if (C0 > 0.02) expect(Math.abs(hueDifference(h0, h))).toBeLessThan(0.1);
      }
    }
  });

  it('rolls boosts off smoothly as colours approach the gamut boundary', () => {
    // Paths that brighten into a clipped channel, where the gamut narrows sharply with lightness.
    const paths: ((t: number) => Rgb)[] = [(t) => [0.375, t, 0.84], (t) => [t, t, 0.1], (t) => [t, 0.6 * t, 0.05]];
    for (const path of paths) {
      for (let i = 0; i < 40; i++) {
        const a = path(0.9 + i * 0.0025);
        const b = path(0.9 + (i + 1) * 0.0025);
        expect(deltaE(saturation(a, 0.25), saturation(b, 0.25)) / deltaE(a, b), a.join(',')).toBeLessThan(1.5);
      }
    }
  });
});

describe('saturation and vibrance', () => {
  it('saturation 0 is the identity and −1 gives a grey of equal lightness', () => {
    for (const c of GRID) {
      expectRgbClose(saturation(c, 0), c, 5);
      const grey = saturation(c, -1);
      expect(Math.abs(grey[0] - grey[1])).toBeLessThan(1e-6);
      expect(Math.abs(grey[1] - grey[2])).toBeLessThan(1e-6);
      expect(rgbToOklab(grey)[0]).toBeCloseTo(rgbToOklab(c)[0], 6);
    }
  });

  it('saturation boosts chroma at constant hue and stays in gamut', () => {
    const muted: Rgb = [0.55, 0.45, 0.35];
    const [, c0, h0] = lch(muted);
    const [, c1, h1] = lch(saturation(muted, 0.5));
    expect(c1).toBeCloseTo(c0 * 1.5, 6);
    expect(Math.abs(hueDifference(h0, h1))).toBeLessThan(1e-3);
    for (const c of GRID) expectInGamut(saturation(c, 1));
  });

  it('vibrance boosts muted colours more than vivid ones and spares skin', () => {
    const gain = (c: Rgb) => lch(vibrance(c, 0.5))[1] / lch(c)[1];
    expect(gain([0.5, 0.55, 0.6])).toBeGreaterThan(gain([0.1, 0.4, 0.9]));
    const skin = SKIN_TONES.typical!;
    const [L, C, h] = lch(skin);
    const teal = oklabToRgbInGamut(oklchToOklab([L, C, h + 150]));
    expect(gain(skin) - 1).toBeLessThan(0.5 * (gain(teal) - 1));
    for (const c of GRID) expectRgbClose(vibrance(c, 0), c, 5);
  });
});

describe('whiteBalance', () => {
  it('is the identity at zero', () => {
    for (const c of GRID) expectRgbClose(whiteBalance(c, 0, 0), c, 9);
  });

  it('warms, cools and tints neutral greys while keeping their luminance', () => {
    const grey: Rgb = [0.5, 0.5, 0.5];
    const warm = whiteBalance(grey, 0.4, 0);
    expect(warm[0]).toBeGreaterThan(warm[1]);
    expect(warm[1]).toBeGreaterThan(warm[2]);
    const cool = whiteBalance(grey, -0.4, 0);
    expect(cool[2]).toBeGreaterThan(cool[1]);
    expect(cool[1]).toBeGreaterThan(cool[0]);
    const magenta = whiteBalance(grey, 0, 0.5);
    expect(magenta[1]).toBeLessThan(magenta[0]);
    expect(magenta[0]).toBeCloseTo(magenta[2], 9);
    const green = whiteBalance(grey, 0, -0.5);
    expect(green[1]).toBeGreaterThan(green[0]);
    for (const c of [warm, cool, magenta, green]) expect(luminance(c)).toBeCloseTo(luminance(grey), 9);
  });

  it('keeps extreme settings inside the gamut', () => {
    for (const c of GRID) expectInGamut(whiteBalance(c, 1, -1));
  });

  it('clips channels pushed past white rather than paling clipped colours', () => {
    const yellow = whiteBalance([1, 1, 0], 0.2, 0);
    expect(yellow[0]).toBeCloseTo(1, 12);
    expect(yellow[2]).toBe(0);
    for (const [c, t] of [[[1, 1, 0], 0.3], [[0, 1, 1], -0.3], [[1, 0.6, 0], 0.3]] as const) {
      expect(lch(whiteBalance(c, t, 0))[1]).toBeGreaterThan(0.97 * lch(c)[1]);
    }
  });
});

describe('splitTone', () => {
  const tones = { shadowHue: 220, shadowAmount: 0.04, highlightHue: 60, highlightAmount: 0.04 };

  it('is the identity with zero amounts', () => {
    for (const c of GRID) {
      expectRgbClose(splitTone(c, { shadowHue: 220, shadowAmount: 0, highlightHue: 60, highlightAmount: 0 }), c, 5);
    }
  });

  it('tints shadows and highlights with their hues at constant lightness', () => {
    const dark: Rgb = [0.15, 0.15, 0.15];
    const bright: Rgb = [0.85, 0.85, 0.85];
    const [Ld, , hd] = lch(splitTone(dark, tones));
    const [Lb, , hb] = lch(splitTone(bright, tones));
    expect(Math.abs(hueDifference(220, hd))).toBeLessThan(2);
    expect(Math.abs(hueDifference(60, hb))).toBeLessThan(2);
    expect(Ld).toBeCloseTo(rgbToOklab(dark)[0], 6);
    expect(Lb).toBeCloseTo(rgbToOklab(bright)[0], 6);
  });

  it('keeps pure black and white neutral', () => {
    expect(to8bit(splitTone([0, 0, 0], tones))).toEqual([0, 0, 0]);
    expect(to8bit(splitTone([1, 1, 1], tones))).toEqual([255, 255, 255]);
  });

  it('does not pale clipped colours tinted towards a neighbouring hue', () => {
    // E.g. a warm highlight tint over a blown-out yellow: there is no room to
    // add the tint, so the colour must stay put rather than lose its chroma.
    for (const c of CLIPPED) {
      const [, C, h] = lch(c);
      for (const offset of [-45, 0, 45]) {
        const hue = h + offset;
        const toned = splitTone(c, { shadowHue: hue, shadowAmount: 0.06, highlightHue: hue, highlightAmount: 0.06 });
        expect(lch(toned)[1], `${c.join(',')} tinted at ${hue}`).toBeGreaterThan(0.97 * C);
      }
    }
  });

  it('balance moves the crossover', () => {
    const mid: Rgb = [0.45, 0.45, 0.45];
    const highlightBias = lch(splitTone(mid, { ...tones, balance: 1 }))[2];
    const shadowBias = lch(splitTone(mid, { ...tones, balance: -1 }))[2];
    expect(Math.abs(hueDifference(60, highlightBias))).toBeLessThan(Math.abs(hueDifference(60, shadowBias)));
  });
});

describe('channelMixer', () => {
  it('is the identity for the identity matrix', () => {
    for (const c of GRID) {
      expectRgbClose(channelMixer(c, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]), c, 9);
    }
  });

  it('produces exact greys from equal rows and keeps neutrals when rows sum to 1', () => {
    const w: Rgb = [0.3, 0.6, 0.1];
    for (const c of GRID) {
      const [r, g, b] = channelMixer(c, [w, w, w]);
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
    expectRgbClose(channelMixer([0.4, 0.4, 0.4], [[0.8, 0.3, -0.1], [0.1, 0.8, 0.1], [0, 0.2, 0.8]]), [0.4, 0.4, 0.4], 9);
  });

  it('mixes in linear light', () => {
    const swapped = channelMixer([0.8, 0.2, 0.5], [[0, 1, 0], [1, 0, 0], [0, 0, 1]]);
    expectRgbClose(swapped, [0.2, 0.8, 0.5], 9);
    const half = channelMixer([1, 0, 0], [[0.5, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(half[0]).toBeCloseTo(linearToSrgb(0.5), 9);
  });
});

describe('skin helpers', () => {
  it('skinToneWeight recognises complexions and rejects other colours', () => {
    for (const c of Object.values(SKIN_TONES)) expect(skinToneWeight(c)).toBeGreaterThan(0.8);
    const others: Rgb[] = [
      [0.45, 0.65, 0.9], // sky
      [0.3, 0.5, 0.2], // foliage
      [0.5, 0.5, 0.5], // grey
      [0.9, 0.1, 0.1], // saturated red
      [1, 0.5, 0], // saturated orange
      [0.6, 0.3, 0.7], // violet
    ];
    for (const c of others) expect(skinToneWeight(c)).toBeLessThan(0.1);
  });

  it('protectColor restores hue and chroma but keeps the graded lightness', () => {
    const original = SKIN_TONES.typical!;
    const graded = oklabToRgbInGamut(oklchToOklab([0.7, 0.05, 140]));
    expectRgbClose(protectColor(original, graded, 0, 0), graded, 5);
    const [L, C, h] = lch(protectColor(original, graded, 1, 1));
    const [, C0, h0] = lch(original);
    expect(L).toBeCloseTo(0.7, 6);
    expect(C).toBeCloseTo(C0, 6);
    expect(Math.abs(hueDifference(h0, h))).toBeLessThan(1e-3);
    const halfway = lch(protectColor(original, graded, 0.5, 0))[2];
    expect(Math.abs(hueDifference(halfway, (h0 + 140) / 2))).toBeLessThan(1e-3);
  });

  it('protectColor leaves near-neutral hues alone', () => {
    const grey: Rgb = [0.5, 0.5, 0.5];
    const tinted = oklabToRgbInGamut(oklchToOklab([0.6, 0.04, 250]));
    expectRgbClose(protectColor(grey, tinted, 1, 0), tinted, 5);
  });
});
