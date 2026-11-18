/**
 * Built-in colour looks (滤镜). Every look is an original design expressed as
 * a chain of operations from ./color, sampled into a 3D LUT on demand.
 *
 * Portrait safety: colour looks end with `protectColor`, weighted by how
 * skin-like the input colour is, so creative grades keep complexions within
 * natural hues and saturation (no green, grey-violet, magenta or drained
 * skin). Tone curves end at or below white with a soft shoulder, and warming
 * happens after that shoulder, so highlights keep their separation.
 */
import { ORIGINAL_LOOK_ID } from '../engine/types';
import {
  LUMINANCE_WEIGHTS,
  applyCurves,
  contrast,
  fade,
  linearToSrgb,
  monotoneCurve,
  oklabToRgbInGamut,
  oklchToOklab,
  protectColor,
  rgbToOklab,
  saturation,
  skinToneWeight,
  splitTone,
  srgbToLinear,
  vibrance,
  whiteBalance,
  type ChannelCurves,
  type Curve,
  type CurvePoint,
  type Rgb,
} from './color';
import type { ColorFn, LutData } from './lut';
import { buildLut, DEFAULT_LUT_SIZE } from './lut';

export type LookCategory = 'natural' | 'portrait' | 'film' | 'vivid' | 'mono' | 'creative';

export interface Look {
  /** Stable id stored in documents and presets. */
  id: string;
  name: { en: string; zh: string };
  category: LookCategory;
  /** Build the look's LUT (deterministic). */
  build(size?: number): LutData;
}

type Step = (c: Rgb) => Rgb;

interface LookDefinition {
  id: string;
  name: { en: string; zh: string };
  category: LookCategory;
  transform: ColorFn;
}

/** How strongly (0..1) a look pulls skin hue and chroma back towards the input's. */
interface SkinProtection {
  hue: number;
  chroma: number;
}

/**
 * Runs `steps` in order, then pulls the result's hue and chroma back towards
 * the input's by `skin` × skinToneWeight(input).
 */
function grade(steps: readonly Step[], skin: SkinProtection): ColorFn {
  return (r, g, b) => {
    const input: Rgb = [r, g, b];
    let c = input;
    for (const step of steps) c = step(c);
    const w = skinToneWeight(input);
    return w > 0 ? protectColor(input, c, skin.hue * w, skin.chroma * w) : c;
  };
}

/** A ChannelCurves step from control points (each built once with monotoneCurve). */
function curves(spec: { [K in keyof ChannelCurves]: readonly CurvePoint[] }): Step {
  const built: ChannelCurves = {};
  for (const key of ['master', 'r', 'g', 'b'] as const) {
    const points = spec[key];
    if (points) built[key] = monotoneCurve(points);
  }
  return (c) => applyCurves(c, built);
}

/** Black and white: a linear-light channel mix (weights sum to 1) shaped by an sRGB tone curve. */
function monochrome(weights: Rgb, tonePoints: readonly CurvePoint[], finish: (v: number) => Rgb): ColorFn {
  const tone: Curve = monotoneCurve(tonePoints);
  return (r, g, b) => {
    const y = weights[0] * srgbToLinear(r) + weights[1] * srgbToLinear(g) + weights[2] * srgbToLinear(b);
    return finish(tone(linearToSrgb(y)));
  };
}

const neutralGrey = (v: number): Rgb => [v, v, v];

const SEPIA_HUE = 68;
const SEPIA_CHROMA = 0.05;

/** Tints a grey value brown at constant OKLab lightness; chroma peaks in the mid-tones and vanishes at black and white. */
function sepiaTone(v: number): Rgb {
  const L = rgbToOklab([v, v, v])[0];
  return oklabToRgbInGamut(oklchToOklab([L, SEPIA_CHROMA * 4 * L * (1 - L), SEPIA_HUE]));
}

const DEFINITIONS: readonly LookDefinition[] = [
  {
    // No change: the exact identity LUT.
    id: ORIGINAL_LOOK_ID,
    name: { en: 'Original', zh: '原图' },
    category: 'natural',
    transform: (r, g, b) => [r, g, b],
  },
  {
    // Gentle polish for any photo: a touch of contrast and vibrance, faintly warm.
    id: 'natural',
    name: { en: 'Natural', zh: '自然' },
    category: 'natural',
    transform: grade(
      [(c) => contrast(c, 0.1), (c) => vibrance(c, 0.18), (c) => whiteBalance(c, 0.04, 0.01)],
      { hue: 0.5, chroma: 0 },
    ),
  },
  {
    // Bright and airy with clean cyan-leaning shadows; skin stays fair and natural.
    id: 'fresh',
    name: { en: 'Fresh', zh: '清新' },
    category: 'natural',
    transform: grade(
      [
        curves({ master: [[0, 0.02], [0.25, 0.29], [0.5, 0.57], [0.75, 0.81], [1, 0.985]] }),
        (c) => whiteBalance(c, -0.08, 0.02),
        (c) => splitTone(c, { shadowHue: 200, shadowAmount: 0.03, highlightHue: 210, highlightAmount: 0.005 }),
        (c) => saturation(c, -0.06),
        (c) => vibrance(c, 0.12),
      ],
      { hue: 0.7, chroma: 0.45 },
    ),
  },
  {
    // Golden late-afternoon warmth with soft contrast; flattering on skin.
    id: 'warm',
    name: { en: 'Warm', zh: '暖阳' },
    category: 'natural',
    transform: grade(
      [
        curves({ master: [[0, 0], [0.7, 0.7], [1, 0.955]] }),
        (c) => whiteBalance(c, 0.18, 0.03),
        (c) => splitTone(c, { shadowHue: 40, shadowAmount: 0.01, highlightHue: 75, highlightAmount: 0.02 }),
        (c) => contrast(c, 0.08),
      ],
      { hue: 0.4, chroma: 0.4 },
    ),
  },
  {
    // Crisp cool daylight: blue-leaning shadows, near-neutral highlights, skin kept natural rather than grey.
    id: 'cool',
    name: { en: 'Cool', zh: '冷调' },
    category: 'natural',
    transform: grade(
      [
        curves({ master: [[0, 0], [0.7, 0.7], [1, 0.965]] }),
        (c) => whiteBalance(c, -0.2, 0.04),
        (c) => splitTone(c, { shadowHue: 245, shadowAmount: 0.025, highlightHue: 220, highlightAmount: 0.008 }),
        (c) => contrast(c, 0.08),
        (c) => saturation(c, -0.05),
      ],
      { hue: 0.7, chroma: 0.45 },
    ),
  },
  {
    // Colour-negative print feel: gentle S-curve, softly lifted blacks, warm highlights over slightly teal shadows.
    id: 'film',
    name: { en: 'Film', zh: '胶片' },
    category: 'film',
    transform: grade(
      [
        curves({
          master: [[0, 0.035], [0.2, 0.17], [0.5, 0.51], [0.8, 0.84], [1, 0.97]],
          b: [[0, 0.03], [0.5, 0.49], [1, 0.96]],
        }),
        (c) => splitTone(c, { shadowHue: 200, shadowAmount: 0.02, highlightHue: 70, highlightAmount: 0.02 }),
        (c) => saturation(c, -0.08),
      ],
      { hue: 0.5, chroma: 0.2 },
    ),
  },
  {
    // Faded, matte film with milky blacks, dimmed whites, muted colour and a warm cast, like an old print.
    id: 'film-fade',
    name: { en: 'Faded Film', zh: '褪色胶片' },
    category: 'film',
    transform: grade(
      [
        (c) => fade(c, 0.1),
        curves({ master: [[0, 0], [0.5, 0.49], [1, 0.94]] }),
        (c) => contrast(c, -0.1),
        (c) => saturation(c, -0.22),
        (c) => whiteBalance(c, 0.08, 0.02),
        (c) => splitTone(c, { shadowHue: 190, shadowAmount: 0.015, highlightHue: 75, highlightAmount: 0.015 }),
      ],
      { hue: 0.5, chroma: 0.25 },
    ),
  },
  {
    // Soft, luminous portrait light: lowered contrast, rolled-off highlights and a gentle warm-pink glow.
    id: 'portrait-soft',
    name: { en: 'Soft Portrait', zh: '柔光人像' },
    category: 'portrait',
    transform: grade(
      [
        curves({ master: [[0, 0.03], [0.3, 0.33], [0.6, 0.65], [0.85, 0.88], [1, 0.97]] }),
        (c) => contrast(c, -0.12),
        (c) => whiteBalance(c, 0.05, 0.06),
        (c) => splitTone(c, { shadowHue: 30, shadowAmount: 0.005, highlightHue: 30, highlightAmount: 0.012 }),
        (c) => saturation(c, -0.04),
      ],
      { hue: 0.4, chroma: 0.2 },
    ),
  },
  {
    // Peachy-pink glow: rosy highlights and light, warm brightening for a healthy complexion.
    id: 'rosy',
    name: { en: 'Peach', zh: '蜜桃' },
    category: 'portrait',
    transform: grade(
      [
        curves({ master: [[0, 0.015], [0.5, 0.55], [0.8, 0.83], [1, 0.94]] }),
        (c) => whiteBalance(c, 0.05, 0.12),
        (c) => splitTone(c, { shadowHue: 350, shadowAmount: 0.01, highlightHue: 25, highlightAmount: 0.018 }),
        (c) => vibrance(c, 0.05),
      ],
      { hue: 0.3, chroma: 0.2 },
    ),
  },
  {
    // Airy Japanese-magazine look: bright, low contrast, slightly desaturated with cyan shadows; skin stays clean.
    id: 'japanese',
    name: { en: 'Japanese', zh: '日系' },
    category: 'portrait',
    transform: grade(
      [
        curves({ master: [[0, 0.05], [0.25, 0.33], [0.5, 0.6], [0.75, 0.83], [1, 0.98]] }),
        (c) => saturation(c, -0.18),
        (c) => whiteBalance(c, -0.1, 0),
        (c) => splitTone(c, { shadowHue: 190, shadowAmount: 0.03, highlightHue: 95, highlightAmount: 0.008 }),
      ],
      { hue: 0.8, chroma: 0.45 },
    ),
  },
  {
    // Punchy colour and contrast for landscapes, food and travel, with skin held back from turning orange.
    id: 'vivid',
    name: { en: 'Vivid', zh: '鲜艳' },
    category: 'vivid',
    transform: grade([(c) => contrast(c, 0.18), (c) => vibrance(c, 0.35), (c) => saturation(c, 0.08)], {
      hue: 0.6,
      chroma: 0.5,
    }),
  },
  {
    // Teal-and-orange screen grade: cool teal shadows, warm skin-friendly highlights, firm contrast.
    id: 'cinematic',
    name: { en: 'Cinematic', zh: '电影感' },
    category: 'creative',
    transform: grade(
      [
        (c) => contrast(c, 0.15),
        (c) => fade(c, 0.025),
        curves({ master: [[0, 0], [0.85, 0.85], [1, 0.97]] }),
        (c) => splitTone(c, { shadowHue: 215, shadowAmount: 0.045, highlightHue: 62, highlightAmount: 0.03 }),
        (c) => saturation(c, -0.1),
      ],
      { hue: 0.5, chroma: 0.2 },
    ),
  },
  {
    // Seventies-print nostalgia: warm yellow cast, compressed blues and soft faded contrast.
    id: 'retro',
    name: { en: 'Retro', zh: '复古' },
    category: 'film',
    transform: grade(
      [
        (c) => fade(c, 0.06),
        curves({
          r: [[0, 0.02], [0.5, 0.53], [1, 0.98]],
          g: [[0, 0.03], [0.5, 0.5], [1, 0.96]],
          b: [[0, 0.08], [0.5, 0.47], [1, 0.86]],
        }),
        (c) => saturation(c, -0.15),
        (c) => whiteBalance(c, 0.08, 0),
      ],
      { hue: 0.5, chroma: 0.2 },
    ),
  },
  {
    // Neutral black and white from true luminance with a gentle tonal curve.
    id: 'mono',
    name: { en: 'Mono', zh: '黑白' },
    category: 'mono',
    transform: monochrome(
      LUMINANCE_WEIGHTS,
      [[0, 0.01], [0.25, 0.235], [0.5, 0.5], [0.75, 0.765], [1, 1]],
      neutralGrey,
    ),
  },
  {
    // Dramatic high-contrast black and white; an orange-filter mix keeps skin luminous and darkens skies.
    id: 'mono-contrast',
    name: { en: 'High-Contrast Mono', zh: '高对比黑白' },
    category: 'mono',
    transform: monochrome(
      [0.35, 0.55, 0.1],
      [[0, 0], [0.15, 0.06], [0.5, 0.5], [0.85, 0.93], [1, 1]],
      neutralGrey,
    ),
  },
  {
    // Warm brown-toned monochrome with softened blacks, like an aged photograph.
    id: 'sepia',
    name: { en: 'Sepia', zh: '怀旧' },
    category: 'mono',
    transform: monochrome(LUMINANCE_WEIGHTS, [[0, 0.04], [0.5, 0.53], [1, 0.97]], sepiaTone),
  },
];

const LOOKS: readonly Look[] = DEFINITIONS.map(({ id, name, category, transform }) => ({
  id,
  name,
  category,
  build: (size = DEFAULT_LUT_SIZE) => buildLut(transform, size),
}));

export function listLooks(): readonly Look[] {
  return LOOKS;
}

export function getLook(id: string): Look | undefined {
  return LOOKS.find((l) => l.id === id);
}

/** The colour transform (sRGB 0..1 in, unclamped out) that a look's `build` samples; for CPU previews and tests. */
export function getLookTransform(id: string): ColorFn | undefined {
  return DEFINITIONS.find((d) => d.id === id)?.transform;
}
