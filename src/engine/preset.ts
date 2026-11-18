import {
  coerceParam,
  completeParams,
  isLayerKind,
  isParamKey,
  upsertLayer,
  type EditDocument,
  type LayerPatch,
} from './document';
import { LAYER_KINDS, isIdentityLayer, type AnyLayer, type LayerKind, type LayerParams } from './types';

/**
 * Shareable preset files (JSON). Presets never include `transform` (crop is
 * per-photo). Example:
 * { "format": "openmeitu.preset", "version": 1, "name": "Soft",
 *   "layers": [{ "kind": "skinSmooth", "params": { "amount": 0.5 } }] }
 */
export const PRESET_FORMAT = 'openmeitu.preset';
export const PRESET_VERSION = 1;

export interface PresetLayer {
  kind: Exclude<LayerKind, 'transform'>;
  enabled?: boolean;
  opacity?: number;
  params: Record<string, unknown>;
}

export interface Preset {
  format: typeof PRESET_FORMAT;
  version: typeof PRESET_VERSION;
  name: string;
  /** Optional localised display names. */
  names?: { en?: string; zh?: string };
  layers: PresetLayer[];
}

export type ParsePresetResult =
  | { ok: true; preset: Preset; warnings: string[] }
  | { ok: false; error: string };

type PresetKind = PresetLayer['kind'];

const UNTITLED = 'Untitled';
const NAME_LOCALES = ['en', 'zh'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Short, safe rendering of an untrusted value for warning messages. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'number' || typeof value === 'boolean' || value === undefined) return String(value);
  return `a ${typeof value}`;
}

/**
 * Captures the document's look: every layer that changes the image except
 * `transform` (crop and rotation are per-photo). Layer ids are not stored;
 * opacity is stored only when below 1.
 */
export function documentToPreset(doc: EditDocument, name: string): Preset {
  const layers: PresetLayer[] = [];
  for (const layer of doc.layers) {
    if (layer.kind === 'transform' || isIdentityLayer(layer)) continue;
    const entry: PresetLayer = { kind: layer.kind, params: { ...layer.params } };
    if (layer.opacity < 1) entry.opacity = layer.opacity;
    layers.push(entry);
  }
  return { format: PRESET_FORMAT, version: PRESET_VERSION, name: name.trim() || UNTITLED, layers };
}

/**
 * Validate untrusted input (object or JSON string). Unknown kinds/params become warnings.
 * Only valid params present in the input are kept (clamped into range), so a
 * preset that sets a single slider leaves the others alone in `merge` mode.
 * Duplicate kinds keep the last layer; layers come back in stage order.
 */
export function parsePreset(input: unknown): ParsePresetResult {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input.replace(/^\uFEFF/, ''));
    } catch (err) {
      return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (!isRecord(data)) return { ok: false, error: 'A preset must be a JSON object.' };
  if (data.format !== PRESET_FORMAT) {
    return { ok: false, error: `Not an OpenMeitu preset: expected "format": "${PRESET_FORMAT}".` };
  }
  const { version } = data;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: `Invalid preset version ${describe(version)}: expected a positive integer.` };
  }
  if (version > PRESET_VERSION) {
    return {
      ok: false,
      error: `Preset version ${version} is newer than this version of OpenMeitu supports (${PRESET_VERSION}). Please update the app.`,
    };
  }
  if (!Array.isArray(data.layers)) return { ok: false, error: 'Invalid preset: "layers" must be an array.' };

  const warnings: string[] = [];
  const names = parseNames(data.names, warnings);
  const name =
    typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : (names?.en ?? names?.zh);
  if (name === undefined) warnings.push(`Preset has no name; using "${UNTITLED}".`);

  const preset: Preset = { format: PRESET_FORMAT, version: PRESET_VERSION, name: name ?? UNTITLED, layers: [] };
  if (names) preset.names = names;

  const byKind = new Map<PresetKind, PresetLayer>();
  data.layers.forEach((raw: unknown, index: number) => {
    const where = `Layer ${index + 1}`;
    if (!isRecord(raw)) {
      warnings.push(`${where} is not an object; ignored.`);
      return;
    }
    const { kind } = raw;
    if (!isLayerKind(kind)) {
      warnings.push(`${where}: unknown layer kind ${describe(kind)}; ignored.`);
      return;
    }
    if (kind === 'transform') {
      warnings.push(`${where}: "transform" layers are not stored in presets (crop and rotation are per-photo); ignored.`);
      return;
    }
    if (byKind.has(kind)) warnings.push(`${where}: duplicate "${kind}" layer replaces the earlier one.`);
    byKind.set(kind, parseLayer(kind, raw, `${where} (${kind})`, warnings));
  });
  for (const kind of LAYER_KINDS) {
    const layer = kind === 'transform' ? undefined : byKind.get(kind);
    if (layer) preset.layers.push(layer);
  }
  return { ok: true, preset, warnings };
}

function parseNames(raw: unknown, warnings: string[]): Preset['names'] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push('"names" must be an object; ignored.');
    return undefined;
  }
  const names: NonNullable<Preset['names']> = {};
  for (const locale of NAME_LOCALES) {
    const value = raw[locale];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() !== '') names[locale] = value.trim();
    else warnings.push(`"names.${locale}" must be a non-empty string; ignored.`);
  }
  return names.en === undefined && names.zh === undefined ? undefined : names;
}

function parseLayer(kind: PresetKind, raw: Record<string, unknown>, where: string, warnings: string[]): PresetLayer {
  const layer: PresetLayer = { kind, params: {} };

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') layer.enabled = raw.enabled;
    else warnings.push(`${where}: "enabled" must be true or false, got ${describe(raw.enabled)}; ignored.`);
  }

  const { opacity } = raw;
  if (opacity !== undefined) {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity)) {
      warnings.push(`${where}: invalid opacity ${describe(opacity)}; ignored.`);
    } else {
      layer.opacity = Math.min(1, Math.max(0, opacity));
      if (layer.opacity !== opacity) warnings.push(`${where}: opacity ${opacity} is out of range; clamped to ${layer.opacity}.`);
    }
  }

  if (raw.params !== undefined && !isRecord(raw.params)) {
    warnings.push(`${where}: "params" must be an object, got ${describe(raw.params)}; ignored.`);
  } else {
    for (const [key, value] of Object.entries(raw.params ?? {})) {
      if (!isParamKey(kind, key)) {
        warnings.push(`${where}: unknown parameter ${describe(key)}; ignored.`);
        continue;
      }
      const coerced = coerceParam(kind, key, value);
      if (!coerced) {
        warnings.push(`${where}: invalid value ${describe(value)} for "${key}"; ignored.`);
        continue;
      }
      if (coerced.clamped) {
        warnings.push(`${where}: "${key}" ${describe(value)} is out of range; clamped to ${describe(coerced.value)}.`);
      }
      layer.params[key] = coerced.value;
    }
  }
  return layer;
}

export interface ApplyPresetOptions {
  /** Kinds whose current layers `replace` keeps when the preset has no layer of that kind. */
  keep?: readonly LayerKind[];
}

/**
 * `replace`: drop every non-transform layer (except `keep` kinds the preset
 * does not set), then add the preset's layers.
 * `merge`: upsert the preset's layers, keep the others.
 * The transform layer is always kept.
 * Applied layers take the preset's `enabled`/`opacity` (default, also for
 * invalid values in presets that skipped `parsePreset`: enabled, opacity 1).
 * In `replace` mode unspecified params are defaults; in `merge` mode they
 * keep the document's current values. Existing layer ids are reused, so
 * re-applying the same preset returns `doc` itself.
 */
export function applyPreset(
  doc: EditDocument,
  preset: Preset,
  mode: 'replace' | 'merge' = 'replace',
  { keep = [] }: ApplyPresetOptions = {},
): EditDocument {
  const presetKinds = new Set<LayerKind>();
  let result = doc;
  for (const layer of preset.layers) {
    const kind: unknown = layer.kind;
    if (!isLayerKind(kind) || kind === 'transform') continue;
    presetKinds.add(kind);
    const params: LayerPatch<PresetKind>['params'] =
      mode === 'replace' ? completeParams(kind, layer.params) : (layer.params as LayerPatch<PresetKind>['params']);
    const enabled = typeof layer.enabled === 'boolean' ? layer.enabled : true;
    const opacity = typeof layer.opacity === 'number' && Number.isFinite(layer.opacity) ? layer.opacity : 1;
    result = upsertLayer(result, kind, { params, enabled, opacity });
  }
  if (mode === 'replace') {
    const kept = (layer: AnyLayer) => layer.kind === 'transform' || presetKinds.has(layer.kind) || keep.includes(layer.kind);
    if (!result.layers.every(kept)) result = { layers: result.layers.filter(kept) };
  }
  return result;
}

type BuiltinLayer = { [K in PresetKind]: { kind: K; opacity?: number; params: Partial<LayerParams[K]> } }[PresetKind];

function builtinPreset(names: { en: string; zh: string }, layers: readonly BuiltinLayer[]): Preset {
  return Object.freeze({
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    name: names.en,
    names: Object.freeze({ ...names }),
    layers: Object.freeze(layers.map((layer) => Object.freeze({ ...layer, params: Object.freeze({ ...layer.params }) }))),
  }) as Preset;
}

/** One-tap presets shipped with the app (original values, not copied from any product). */
export const BUILTIN_PRESETS: readonly Preset[] = Object.freeze([
  builtinPreset({ en: 'Natural', zh: '自然' }, [
    { kind: 'skinSmooth', params: { amount: 0.3, detail: 0.5 } },
    { kind: 'skinWhiten', params: { amount: 0.12 } },
    { kind: 'adjust', params: { shadows: 0.06, vibrance: 0.08 } },
    { kind: 'filter', params: { lookId: 'natural', intensity: 0.5 } },
  ]),
  builtinPreset({ en: 'Clear', zh: '清透' }, [
    { kind: 'skinSmooth', params: { amount: 0.4, detail: 0.45 } },
    { kind: 'skinWhiten', params: { amount: 0.28 } },
    { kind: 'teethWhiten', params: { amount: 0.25 } },
    {
      kind: 'adjust',
      params: { exposure: 0.15, contrast: -0.06, highlights: -0.15, shadows: 0.18, vibrance: 0.1, temperature: -0.08 },
    },
    { kind: 'filter', params: { lookId: 'fresh', intensity: 0.6 } },
    { kind: 'sharpen', params: { amount: 0.12, radius: 0.25 } },
  ]),
  builtinPreset({ en: 'Glow', zh: '元气' }, [
    { kind: 'skinSmooth', params: { amount: 0.42, detail: 0.4 } },
    { kind: 'skinWhiten', params: { amount: 0.2 } },
    { kind: 'faceReshape', params: { slim: 0.12, eyes: 0.1 } },
    { kind: 'adjust', params: { exposure: 0.08, contrast: 0.05, vibrance: 0.22, temperature: 0.07, tint: 0.04 } },
    { kind: 'filter', params: { lookId: 'rosy', intensity: 0.5 } },
  ]),
  builtinPreset({ en: 'Refined', zh: '精致' }, [
    { kind: 'skinSmooth', params: { amount: 0.55, detail: 0.32 } },
    { kind: 'skinWhiten', params: { amount: 0.3 } },
    { kind: 'teethWhiten', params: { amount: 0.4 } },
    { kind: 'faceReshape', params: { slim: 0.22, eyes: 0.18, nose: 0.15 } },
    { kind: 'adjust', params: { contrast: 0.08, highlights: -0.12, shadows: 0.05 } },
    { kind: 'filter', params: { lookId: 'portrait-soft', intensity: 0.55 } },
    { kind: 'sharpen', params: { amount: 0.18, radius: 0.3 } },
  ]),
  builtinPreset({ en: 'Film', zh: '胶片' }, [
    { kind: 'skinSmooth', params: { amount: 0.2, detail: 0.6 } },
    { kind: 'adjust', params: { highlights: -0.18, shadows: 0.1, saturation: -0.08, temperature: 0.06 } },
    { kind: 'filter', params: { lookId: 'film', intensity: 0.85 } },
    { kind: 'vignette', params: { amount: -0.22, midpoint: 0.55, feather: 0.6 } },
    { kind: 'grain', params: { amount: 0.22, size: 0.35 } },
  ]),
  builtinPreset({ en: 'Monochrome', zh: '黑白' }, [
    { kind: 'skinSmooth', params: { amount: 0.18, detail: 0.6 } },
    { kind: 'adjust', params: { contrast: 0.12, highlights: -0.1, shadows: 0.04 } },
    { kind: 'filter', params: { lookId: 'mono', intensity: 1 } },
    { kind: 'vignette', params: { amount: -0.18, midpoint: 0.5, feather: 0.65 } },
    { kind: 'grain', params: { amount: 0.12, size: 0.25 } },
  ]),
]);
