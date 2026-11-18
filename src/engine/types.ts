/**
 * Core data model of the OpenMeitu editing engine.
 *
 * An edit is a list of non-destructive layers. Invariants (enforced by
 * `normalizeLayers` in document.ts):
 *  - at most one layer per kind;
 *  - layers are always ordered by stage, i.e. by their index in LAYER_KINDS.
 *
 * The stage order is deliberate: face-dependent retouching runs on the
 * original geometry (so landmark-derived masks line up), then geometry warps,
 * then global colour, then finishing effects, and finally crop/rotate.
 */

export const LAYER_KINDS = [
  'skinSmooth',
  'skinWhiten',
  'teethWhiten',
  'faceReshape',
  'adjust',
  'filter',
  'sharpen',
  'vignette',
  'grain',
  'transform',
] as const;

export type LayerKind = (typeof LAYER_KINDS)[number];

/** Skin smoothing (磨皮). */
export interface SkinSmoothParams {
  /** 0..1 smoothing strength. */
  amount: number;
  /** 0..1 how much fine skin texture is kept (avoids the "plastic" look). */
  detail: number;
}

/** Skin brightening / whitening (美白). */
export interface SkinWhitenParams {
  /** 0..1 */
  amount: number;
}

/** Teeth whitening (美牙). Requires a detected face. */
export interface TeethWhitenParams {
  /** 0..1 */
  amount: number;
}

/** Landmark-driven face reshaping (瘦脸/大眼/瘦鼻/下巴). Requires a detected face. */
export interface FaceReshapeParams {
  /** 0..1 slim the cheeks/jaw towards the face centre. */
  slim: number;
  /** 0..1 enlarge the eyes. */
  eyes: number;
  /** 0..1 narrow the nose. */
  nose: number;
  /** -1..1 shorten (<0) or lengthen (>0) the chin. */
  chin: number;
}

/** Global tone and colour (调色). All values are 0 at identity. */
export interface AdjustParams {
  /** -2..2 exposure in EV stops. */
  exposure: number;
  /** -1..1 */
  contrast: number;
  /** -1..1 recover (<0) or boost (>0) highlights. */
  highlights: number;
  /** -1..1 deepen (<0) or lift (>0) shadows. */
  shadows: number;
  /** -1..1 */
  saturation: number;
  /** -1..1 saturation that protects already-saturated colours and skin. */
  vibrance: number;
  /** -1..1 cool (<0) / warm (>0) white balance. */
  temperature: number;
  /** -1..1 green (<0) / magenta (>0). */
  tint: number;
}

/** Colour look (滤镜) applied through a 3D LUT. */
export interface FilterParams {
  /** Built-in look id (see filters/looks.ts) or `custom:<id>` for an imported .cube. */
  lookId: string;
  /** 0..1 blend between original and the look. */
  intensity: number;
}

export interface SharpenParams {
  /** 0..1 */
  amount: number;
  /** 0..1, mapped to a resolution-independent radius. */
  radius: number;
}

export interface VignetteParams {
  /** -1..1 darken (<0) or lighten (>0) the corners. */
  amount: number;
  /** 0..1 where the falloff starts (0 = centre, 1 = corners). */
  midpoint: number;
  /** 0..1 softness of the falloff. */
  feather: number;
}

export interface GrainParams {
  /** 0..1 */
  amount: number;
  /** 0..1 grain size, resolution independent. */
  size: number;
}

/** Normalised rectangle (0..1) in the rotated/flipped image space. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Geometry. Applied in this order: rotate (clockwise), flip, crop.
 * `crop` is normalised against the image *after* rotate and flip.
 */
export interface TransformParams {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  crop: CropRect | null;
}

export interface LayerParams {
  skinSmooth: SkinSmoothParams;
  skinWhiten: SkinWhitenParams;
  teethWhiten: TeethWhitenParams;
  faceReshape: FaceReshapeParams;
  adjust: AdjustParams;
  filter: FilterParams;
  sharpen: SharpenParams;
  vignette: VignetteParams;
  grain: GrainParams;
  transform: TransformParams;
}

export interface Layer<K extends LayerKind = LayerKind> {
  /** Stable unique id (used by UI lists and history). */
  id: string;
  kind: K;
  /** Disabled layers are kept but skipped by the renderer. */
  enabled: boolean;
  /** 0..1 blend of this layer's result over its input. Applied by the renderer. */
  opacity: number;
  params: LayerParams[K];
}

/** Discriminated union over all layer kinds — use this for arrays of layers. */
export type AnyLayer = { [K in LayerKind]: Layer<K> }[LayerKind];

export const ORIGINAL_LOOK_ID = 'original';

export const DEFAULT_PARAMS: { readonly [K in LayerKind]: Readonly<LayerParams[K]> } = {
  skinSmooth: { amount: 0, detail: 0.35 },
  skinWhiten: { amount: 0 },
  teethWhiten: { amount: 0 },
  faceReshape: { slim: 0, eyes: 0, nose: 0, chin: 0 },
  adjust: {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    saturation: 0,
    vibrance: 0,
    temperature: 0,
    tint: 0,
  },
  filter: { lookId: ORIGINAL_LOOK_ID, intensity: 1 },
  sharpen: { amount: 0, radius: 0.3 },
  vignette: { amount: 0, midpoint: 0.5, feather: 0.5 },
  grain: { amount: 0, size: 0.3 },
  transform: { rotate: 0, flipH: false, flipV: false, crop: null },
};

/** Numeric parameter ranges, used by the UI for sliders and by preset validation. */
export interface NumericParamSpec {
  min: number;
  max: number;
  step: number;
}

/** Keys whose type is exactly `number` (excludes literal unions like `rotate`). */
type NumericKeys<T> = { [P in keyof T]: number extends T[P] ? P : never }[keyof T];

export const PARAM_SPECS: {
  readonly [K in LayerKind]: { readonly [P in NumericKeys<LayerParams[K]>]: NumericParamSpec };
} = {
  skinSmooth: {
    amount: { min: 0, max: 1, step: 0.01 },
    detail: { min: 0, max: 1, step: 0.01 },
  },
  skinWhiten: { amount: { min: 0, max: 1, step: 0.01 } },
  teethWhiten: { amount: { min: 0, max: 1, step: 0.01 } },
  faceReshape: {
    slim: { min: 0, max: 1, step: 0.01 },
    eyes: { min: 0, max: 1, step: 0.01 },
    nose: { min: 0, max: 1, step: 0.01 },
    chin: { min: -1, max: 1, step: 0.01 },
  },
  adjust: {
    exposure: { min: -2, max: 2, step: 0.01 },
    contrast: { min: -1, max: 1, step: 0.01 },
    highlights: { min: -1, max: 1, step: 0.01 },
    shadows: { min: -1, max: 1, step: 0.01 },
    saturation: { min: -1, max: 1, step: 0.01 },
    vibrance: { min: -1, max: 1, step: 0.01 },
    temperature: { min: -1, max: 1, step: 0.01 },
    tint: { min: -1, max: 1, step: 0.01 },
  },
  filter: { intensity: { min: 0, max: 1, step: 0.01 } },
  sharpen: {
    amount: { min: 0, max: 1, step: 0.01 },
    radius: { min: 0, max: 1, step: 0.01 },
  },
  vignette: {
    amount: { min: -1, max: 1, step: 0.01 },
    midpoint: { min: 0, max: 1, step: 0.01 },
    feather: { min: 0, max: 1, step: 0.01 },
  },
  grain: {
    amount: { min: 0, max: 1, step: 0.01 },
    size: { min: 0, max: 1, step: 0.01 },
  },
  transform: {},
};

/** Layer kinds whose effect depends on a detected face. */
export const FACE_DEPENDENT_KINDS: readonly LayerKind[] = ['teethWhiten', 'faceReshape'];

export function stageIndex(kind: LayerKind): number {
  return LAYER_KINDS.indexOf(kind);
}

/**
 * True when the layer cannot change the image (renderer skips it).
 * Note: skin smoothing/whitening do NOT require a face (they fall back to a
 * colour-based skin mask), but teeth/reshape are no-ops without a face.
 */
export function isIdentityLayer(layer: AnyLayer): boolean {
  if (!layer.enabled || layer.opacity <= 0) return true;
  switch (layer.kind) {
    case 'skinSmooth':
      return layer.params.amount <= 0;
    case 'skinWhiten':
    case 'teethWhiten':
      return layer.params.amount <= 0;
    case 'faceReshape': {
      const p = layer.params;
      return p.slim === 0 && p.eyes === 0 && p.nose === 0 && p.chin === 0;
    }
    case 'adjust':
      return Object.values(layer.params).every((v) => v === 0);
    case 'filter':
      return layer.params.lookId === ORIGINAL_LOOK_ID || layer.params.intensity <= 0;
    case 'sharpen':
      return layer.params.amount <= 0;
    case 'vignette':
      return layer.params.amount === 0;
    case 'grain':
      return layer.params.amount <= 0;
    case 'transform': {
      const p = layer.params;
      return p.rotate === 0 && !p.flipH && !p.flipV && p.crop === null;
    }
  }
}
