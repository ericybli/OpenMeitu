import {
  DEFAULT_PARAMS,
  LAYER_KINDS,
  PARAM_SPECS,
  isIdentityLayer,
  stageIndex,
  type AnyLayer,
  type CropRect,
  type Layer,
  type LayerKind,
  type LayerParams,
  type NumericParamSpec,
} from './types';

/**
 * Immutable edit document. Operations never mutate their inputs: they return a
 * new document that shares unchanged layers with the old one, or `doc` itself
 * when nothing changes (so callers can skip history steps with `===`).
 * Invariants (see types.ts): one layer per kind, stage order.
 */
export interface EditDocument {
  readonly layers: readonly AnyLayer[];
}

export interface LayerPatch<K extends LayerKind> {
  params?: Partial<LayerParams[K]>;
  opacity?: number;
  enabled?: boolean;
}

/** A parameter value accepted by `coerceParam`. */
export interface CoercedParam {
  value: unknown;
  /** True when the input had the right type but was moved into range. */
  clamped: boolean;
}

/** Smallest crop side, as a fraction of the image side. */
export const MIN_CROP_SIZE = 0.01;

const ROTATIONS: readonly unknown[] = [0, 90, 180, 270];

let fallbackIdCounter = 0;

/** crypto.randomUUID is missing outside secure contexts (e.g. plain http on a LAN IP). */
function newLayerId(): string {
  const cryptoApi: Crypto | undefined = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  fallbackIdCounter += 1;
  return `layer-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

export function isLayerKind(value: unknown): value is LayerKind {
  return typeof value === 'string' && (LAYER_KINDS as readonly string[]).includes(value);
}

function assertLayerKind(kind: unknown): asserts kind is LayerKind {
  if (!isLayerKind(kind)) throw new TypeError(`Unknown layer kind: ${String(kind)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readOpacity(value: unknown): number | undefined {
  return isFiniteNumber(value) ? clamp(value, 0, 1) : undefined;
}

/** True when `key` is a parameter of `kind` (own keys only, so `__proto__` etc. never match). */
export function isParamKey(kind: LayerKind, key: string): boolean {
  return isLayerKind(kind) && Object.hasOwn(DEFAULT_PARAMS[kind], key);
}

/**
 * Validates one untrusted parameter value. Numbers are clamped to PARAM_SPECS
 * and crops into the image; unknown keys, wrong types, non-finite numbers and
 * disallowed values (e.g. `rotate: 45`) return undefined.
 */
export function coerceParam(kind: LayerKind, key: string, value: unknown): CoercedParam | undefined {
  if (!isParamKey(kind, key)) return undefined;
  const spec = (PARAM_SPECS[kind] as Readonly<Record<string, NumericParamSpec | undefined>>)[key];
  if (spec) {
    if (!isFiniteNumber(value)) return undefined;
    const clamped = clamp(value, spec.min, spec.max);
    return { value: clamped, clamped: clamped !== value };
  }
  if (kind === 'filter' && key === 'lookId') {
    return typeof value === 'string' && value.trim() !== '' ? { value, clamped: false } : undefined;
  }
  if (kind === 'transform') {
    if (key === 'rotate') return ROTATIONS.includes(value) ? { value, clamped: false } : undefined;
    if (key === 'flipH' || key === 'flipV') return typeof value === 'boolean' ? { value, clamped: false } : undefined;
    if (key === 'crop') return value === null ? { value: null, clamped: false } : coerceCrop(value);
  }
  return undefined;
}

/** Keeps the crop size (down to MIN_CROP_SIZE) and shifts it back inside the image if it sticks out. */
function coerceCrop(value: unknown): CoercedParam | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return undefined;
  }
  const w = clamp(width, MIN_CROP_SIZE, 1);
  const h = clamp(height, MIN_CROP_SIZE, 1);
  const crop: CropRect = { x: fitSpanStart(x, w), y: fitSpanStart(y, h), width: w, height: h };
  const clamped = crop.x !== x || crop.y !== y || crop.width !== width || crop.height !== height;
  return { value: crop, clamped };
}

/**
 * Start of a span of `size` (<= 1) placed inside 0..1. A start that already
 * fits is kept exactly: clamping it to `1 - size` would nudge valid crops by
 * rounding error (1 - 0.9 < 0.1 in floating point). `(1 - size) + size`
 * never rounds above 1, so the result always satisfies start + size <= 1.
 */
function fitSpanStart(start: number, size: number): number {
  const inside = Math.max(0, start);
  return inside + size > 1 ? 1 - size : inside;
}

/**
 * Complete params for `kind`: each known key of `raw` that passes
 * `coerceParam` overrides `base` (assumed valid); every other key comes from `base`.
 */
function sanitizeParams<K extends LayerKind>(kind: K, raw: unknown, base: Readonly<LayerParams[K]>): LayerParams[K] {
  const source = isRecord(raw) ? raw : {};
  const baseValues = base as Readonly<Record<string, unknown>>;
  const params: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_PARAMS[kind])) {
    const coerced = Object.hasOwn(source, key) ? coerceParam(kind, key, source[key]) : undefined;
    params[key] = coerced ? coerced.value : baseValues[key];
  }
  return params as unknown as LayerParams[K];
}

function sameValue(a: unknown, b: unknown): boolean {
  return isRecord(a) && isRecord(b) ? sameRecord(a, b) : a === b;
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

function sameLayer(a: AnyLayer, b: AnyLayer): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.enabled === b.enabled &&
    a.opacity === b.opacity &&
    sameValue(a.params, b.params)
  );
}

/** Puts `layer` in place of any layer of its kind, keeping stage order. */
function withLayer(doc: EditDocument, layer: AnyLayer): EditDocument {
  const layers = [...doc.layers.filter((l) => l.kind !== layer.kind), layer];
  layers.sort((a, b) => stageIndex(a.kind) - stageIndex(b.kind));
  return { layers };
}

/** New document from (possibly unsorted / invalid) layers; normalises them. */
export function createDocument(layers: readonly AnyLayer[] = []): EditDocument {
  return { layers: normalizeLayers(layers) };
}

/** Default params for `kind` overlaid with the valid values of `params` (clamped to PARAM_SPECS). */
export function completeParams<K extends LayerKind>(kind: K, params?: unknown): LayerParams[K] {
  assertLayerKind(kind);
  return sanitizeParams(kind, params, DEFAULT_PARAMS[kind]);
}

/** New layer with default params merged with `params` (clamped to PARAM_SPECS). */
export function createLayer<K extends LayerKind>(kind: K, params?: Partial<LayerParams[K]>): Layer<K> {
  return { id: newLayerId(), kind, enabled: true, opacity: 1, params: completeParams(kind, params) };
}

export function getLayer<K extends LayerKind>(doc: EditDocument, kind: K): Layer<K> | undefined {
  return doc.layers.find((layer) => layer.kind === kind) as Layer<K> | undefined;
}

/**
 * Update the layer of `kind`, creating it (enabled, opacity 1) if missing.
 * Patched params are merged over the current ones and clamped; invalid patch
 * values (wrong type, NaN) leave the current value unchanged.
 */
export function upsertLayer<K extends LayerKind>(doc: EditDocument, kind: K, patch: LayerPatch<K>): EditDocument {
  assertLayerKind(kind);
  const existing = getLayer(doc, kind);
  const base = existing ? sanitizeParams(kind, existing.params, DEFAULT_PARAMS[kind]) : DEFAULT_PARAMS[kind];
  const next = {
    id: existing?.id ?? newLayerId(),
    kind,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : (existing?.enabled ?? true),
    opacity: readOpacity(patch.opacity) ?? readOpacity(existing?.opacity) ?? 1,
    params: sanitizeParams(kind, patch.params, base),
  } as AnyLayer;
  if (existing && sameLayer(existing as AnyLayer, next)) return doc;
  return withLayer(doc, next);
}

export function removeLayer(doc: EditDocument, kind: LayerKind): EditDocument {
  if (!doc.layers.some((layer) => layer.kind === kind)) return doc;
  return { layers: doc.layers.filter((layer) => layer.kind !== kind) };
}

/** Restore default params for `kind` (keeps id/enabled/opacity). No-op if absent. */
export function resetLayer(doc: EditDocument, kind: LayerKind): EditDocument {
  const existing = getLayer(doc, kind);
  if (!existing) return doc;
  const reset = { ...existing, params: completeParams(kind) } as AnyLayer;
  return sameLayer(existing as AnyLayer, reset) ? doc : withLayer(doc, reset);
}

/**
 * Sort by stage, keep the LAST layer of each kind, fill missing params with
 * defaults, clamp numbers to PARAM_SPECS, clamp opacity to 0..1, drop unknown
 * kinds and unknown param keys, validate enum-like params (rotate, crop).
 * Invalid values fall back to defaults; missing or duplicate ids are replaced
 * with fresh ones. Safe to call on untrusted JSON; the input is not mutated
 * and the result shares no objects with it.
 */
export function normalizeLayers(layers: readonly unknown[]): AnyLayer[] {
  if (!Array.isArray(layers)) return [];
  const lastOfKind = new Map<LayerKind, Record<string, unknown>>();
  for (const raw of layers) {
    if (isRecord(raw) && isLayerKind(raw.kind)) lastOfKind.set(raw.kind, raw);
  }
  const usedIds = new Set<string>();
  const result: AnyLayer[] = [];
  for (const kind of LAYER_KINDS) {
    const raw = lastOfKind.get(kind);
    if (!raw) continue;
    const id = typeof raw.id === 'string' && raw.id !== '' && !usedIds.has(raw.id) ? raw.id : newLayerId();
    usedIds.add(id);
    result.push({
      id,
      kind,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      opacity: readOpacity(raw.opacity) ?? 1,
      params: sanitizeParams(kind, raw.params, DEFAULT_PARAMS[kind]),
    } as AnyLayer);
  }
  return result;
}

/** True when rendering the document would not change the image. */
export function isDocumentIdentity(doc: EditDocument): boolean {
  return doc.layers.every((layer) => isIdentityLayer(layer));
}
