import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_CROP_SIZE,
  coerceParam,
  completeParams,
  createDocument,
  createLayer,
  getLayer,
  isDocumentIdentity,
  isLayerKind,
  isParamKey,
  normalizeLayers,
  removeLayer,
  resetLayer,
  upsertLayer,
  type EditDocument,
} from '../../src/engine/document';
import { DEFAULT_PARAMS, LAYER_KINDS, type AnyLayer, type LayerKind } from '../../src/engine/types';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function kinds(doc: EditDocument | readonly AnyLayer[]): LayerKind[] {
  const layers = 'layers' in doc ? doc.layers : doc;
  return layers.map((layer) => layer.kind);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isLayerKind / isParamKey', () => {
  it('accepts exactly the known kinds', () => {
    for (const kind of LAYER_KINDS) expect(isLayerKind(kind)).toBe(true);
    for (const junk of ['', 'Transform', 'toString', '__proto__', 1, null, undefined, {}]) {
      expect(isLayerKind(junk)).toBe(false);
    }
  });

  it('only matches own param keys', () => {
    expect(isParamKey('skinSmooth', 'amount')).toBe(true);
    expect(isParamKey('filter', 'lookId')).toBe(true);
    expect(isParamKey('skinSmooth', 'slim')).toBe(false);
    expect(isParamKey('adjust', 'constructor')).toBe(false);
    expect(isParamKey('adjust', '__proto__')).toBe(false);
  });

  it('is false for unknown kinds instead of throwing', () => {
    expect(isParamKey('blur' as LayerKind, 'amount')).toBe(false);
    expect(coerceParam('blur' as LayerKind, 'amount', 0.5)).toBeUndefined();
  });
});

describe('coerceParam', () => {
  it('clamps numbers and flags the clamp', () => {
    expect(coerceParam('skinSmooth', 'amount', 0.4)).toEqual({ value: 0.4, clamped: false });
    expect(coerceParam('skinSmooth', 'amount', 3)).toEqual({ value: 1, clamped: true });
    expect(coerceParam('adjust', 'exposure', -9)).toEqual({ value: -2, clamped: true });
  });

  it('rejects wrong types and non-finite numbers', () => {
    for (const junk of [NaN, Infinity, -Infinity, '0.5', null, undefined, true, [], {}]) {
      expect(coerceParam('skinSmooth', 'amount', junk)).toBeUndefined();
    }
  });

  it('validates non-numeric params', () => {
    expect(coerceParam('filter', 'lookId', 'film')).toEqual({ value: 'film', clamped: false });
    expect(coerceParam('filter', 'lookId', '  ')).toBeUndefined();
    expect(coerceParam('filter', 'lookId', 3)).toBeUndefined();
    expect(coerceParam('transform', 'rotate', 270)).toEqual({ value: 270, clamped: false });
    expect(coerceParam('transform', 'rotate', 45)).toBeUndefined();
    expect(coerceParam('transform', 'rotate', '90')).toBeUndefined();
    expect(coerceParam('transform', 'flipH', true)).toEqual({ value: true, clamped: false });
    expect(coerceParam('transform', 'flipV', 1)).toBeUndefined();
    expect(coerceParam('transform', 'crop', null)).toEqual({ value: null, clamped: false });
  });

  it('rejects unknown keys', () => {
    expect(coerceParam('skinSmooth', 'slim', 0.5)).toBeUndefined();
    expect(coerceParam('transform', 'scale', 1)).toBeUndefined();
  });
});

describe('createLayer', () => {
  it('fills defaults, is enabled at full opacity and gets a fresh id', () => {
    const a = createLayer('skinSmooth');
    const b = createLayer('skinSmooth', { amount: 0.6 });
    expect(a).toMatchObject({ kind: 'skinSmooth', enabled: true, opacity: 1, params: DEFAULT_PARAMS.skinSmooth });
    expect(b.params).toEqual({ ...DEFAULT_PARAMS.skinSmooth, amount: 0.6 });
    expect(typeof a.id).toBe('string');
    expect(a.id).not.toBe('');
    expect(a.id).not.toBe(b.id);
  });

  it('clamps params and ignores invalid or unknown ones', () => {
    const layer = createLayer('adjust', { exposure: 5, contrast: NaN, bogus: 1 } as never);
    expect(layer.params).toEqual({ ...DEFAULT_PARAMS.adjust, exposure: 2 });
    expect(layer.params).not.toHaveProperty('bogus');
  });

  it('never shares objects with DEFAULT_PARAMS or the input', () => {
    const input = { lookId: 'film' };
    const layer = createLayer('filter', input);
    expect(layer.params).not.toBe(DEFAULT_PARAMS.filter);
    expect(layer.params).not.toBe(input);
    layer.params.intensity = 0.1;
    expect(DEFAULT_PARAMS.filter.intensity).toBe(1);

    const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const transform = createLayer('transform', { crop });
    expect(transform.params.crop).toEqual(crop);
    expect(transform.params.crop).not.toBe(crop);
  });

  it('throws on an unknown kind', () => {
    expect(() => createLayer('blur' as LayerKind)).toThrow(/Unknown layer kind/);
  });

  it('falls back to counter ids when crypto.randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const ids = new Set(Array.from({ length: 50 }, () => createLayer('grain').id));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^layer-/);
  });

  it('uses crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-uuid' });
    expect(createLayer('grain').id).toBe('fixed-uuid');
  });
});

describe('completeParams', () => {
  it('returns a fresh default object when given nothing', () => {
    const params = completeParams('vignette');
    expect(params).toEqual(DEFAULT_PARAMS.vignette);
    expect(params).not.toBe(DEFAULT_PARAMS.vignette);
  });

  it('accepts untyped records', () => {
    expect(completeParams('grain', { amount: 0.3, size: 'big', extra: true })).toEqual({ amount: 0.3, size: 0.3 });
  });
});

describe('createDocument', () => {
  it('defaults to an empty document', () => {
    expect(createDocument().layers).toEqual([]);
  });

  it('sorts layers by stage and keeps the last layer of each kind', () => {
    const first = createLayer('skinSmooth', { amount: 0.2 });
    const last = createLayer('skinSmooth', { amount: 0.7 });
    const doc = createDocument([createLayer('transform'), createLayer('grain'), first, createLayer('adjust'), last]);
    expect(kinds(doc)).toEqual(['skinSmooth', 'adjust', 'grain', 'transform']);
    expect(getLayer(doc, 'skinSmooth')?.params.amount).toBe(0.7);
    expect(getLayer(doc, 'skinSmooth')?.id).toBe(last.id);
  });

  it('does not mutate its input', () => {
    const layers = deepFreeze([createLayer('grain', { amount: 0.5 }), createLayer('skinSmooth')]);
    const snapshot = structuredClone(layers);
    const doc = createDocument(layers);
    expect(layers).toEqual(snapshot);
    expect(doc.layers).not.toBe(layers);
  });
});

describe('getLayer', () => {
  it('finds a layer by kind', () => {
    const doc = createDocument([createLayer('filter', { lookId: 'film' })]);
    expect(getLayer(doc, 'filter')?.params.lookId).toBe('film');
    expect(getLayer(doc, 'grain')).toBeUndefined();
  });
});

describe('upsertLayer', () => {
  it('creates a missing layer at its stage position', () => {
    const base = createDocument([createLayer('skinSmooth'), createLayer('grain'), createLayer('transform')]);
    const doc = upsertLayer(base, 'adjust', { params: { exposure: 0.5 } });
    expect(kinds(doc)).toEqual(['skinSmooth', 'adjust', 'grain', 'transform']);
    expect(getLayer(doc, 'adjust')).toMatchObject({
      enabled: true,
      opacity: 1,
      params: { ...DEFAULT_PARAMS.adjust, exposure: 0.5 },
    });
  });

  it('merges params into the existing layer and keeps its id', () => {
    const base = createDocument([createLayer('skinSmooth', { amount: 0.4, detail: 0.9 })]);
    const id = base.layers[0]!.id;
    const doc = upsertLayer(base, 'skinSmooth', { params: { amount: 0.6 } });
    expect(getLayer(doc, 'skinSmooth')).toMatchObject({ id, params: { amount: 0.6, detail: 0.9 } });
  });

  it('clamps params and opacity', () => {
    const doc = upsertLayer(createDocument(), 'faceReshape', { params: { chin: -4, eyes: 2 }, opacity: 7 });
    expect(getLayer(doc, 'faceReshape')).toMatchObject({ opacity: 1, params: { chin: -1, eyes: 1 } });
    const faded = upsertLayer(doc, 'faceReshape', { opacity: -1 });
    expect(getLayer(faded, 'faceReshape')?.opacity).toBe(0);
  });

  it('ignores invalid patch values instead of resetting them', () => {
    const base = upsertLayer(createDocument(), 'sharpen', { params: { amount: 0.5 }, opacity: 0.4 });
    const doc = upsertLayer(base, 'sharpen', {
      params: { amount: NaN, radius: 'wide' as never },
      opacity: Infinity,
      enabled: 'no' as never,
    });
    expect(doc).toBe(base);
  });

  it('updates enabled and opacity without touching params', () => {
    const base = upsertLayer(createDocument(), 'vignette', { params: { amount: -0.4 } });
    const doc = upsertLayer(base, 'vignette', { enabled: false, opacity: 0.5 });
    expect(getLayer(doc, 'vignette')).toMatchObject({ enabled: false, opacity: 0.5, params: { amount: -0.4 } });
  });

  it('returns the same document when nothing changes', () => {
    const base = upsertLayer(createDocument(), 'grain', { params: { amount: 0.3 } });
    expect(upsertLayer(base, 'grain', { params: { amount: 0.3 } })).toBe(base);
    expect(upsertLayer(base, 'grain', {})).toBe(base);
    const cropped = upsertLayer(createDocument(), 'transform', { params: { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } } });
    expect(upsertLayer(cropped, 'transform', { params: { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } } })).toBe(cropped);
  });

  it('never mutates the input document and shares untouched layers', () => {
    const base = deepFreeze(createDocument([createLayer('skinSmooth', { amount: 0.3 }), createLayer('grain')]));
    const snapshot = structuredClone(base);
    const doc = upsertLayer(base, 'skinSmooth', { params: { amount: 0.8 } });
    expect(base).toEqual(snapshot);
    expect(doc).not.toBe(base);
    expect(doc.layers).not.toBe(base.layers);
    expect(getLayer(doc, 'grain')).toBe(getLayer(base, 'grain'));
    expect(getLayer(doc, 'skinSmooth')).not.toBe(getLayer(base, 'skinSmooth'));
  });

  it('validates transform params', () => {
    let doc = upsertLayer(createDocument(), 'transform', { params: { rotate: 90, flipH: true } });
    doc = upsertLayer(doc, 'transform', { params: { rotate: 45 as never, crop: { x: 0.9, y: -1, width: 0.5, height: 2 } } });
    expect(getLayer(doc, 'transform')?.params).toEqual({
      rotate: 90,
      flipH: true,
      flipV: false,
      crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
    });
  });

  it('keeps an existing crop when patching other transform params, without aliasing it', () => {
    const crop = { x: 0.2, y: 0.1, width: 0.6, height: 0.7 };
    const base = upsertLayer(createDocument(), 'transform', { params: { crop } });
    const doc = upsertLayer(base, 'transform', { params: { rotate: 270, flipV: true } });
    const before = getLayer(base, 'transform')!.params;
    const after = getLayer(doc, 'transform')!.params;
    expect(after).toEqual({ rotate: 270, flipH: false, flipV: true, crop });
    expect(after.crop).not.toBe(before.crop);
    expect(before).toEqual({ ...DEFAULT_PARAMS.transform, crop });
  });

  it('clears the crop with null', () => {
    const base = upsertLayer(createDocument(), 'transform', { params: { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } } });
    expect(getLayer(upsertLayer(base, 'transform', { params: { crop: null } }), 'transform')?.params.crop).toBeNull();
  });

  it('throws on an unknown kind', () => {
    expect(() => upsertLayer(createDocument(), 'nope' as LayerKind, {})).toThrow(/Unknown layer kind/);
  });
});

describe('removeLayer', () => {
  it('removes the layer of a kind', () => {
    const base = createDocument([createLayer('skinSmooth'), createLayer('grain')]);
    const doc = removeLayer(base, 'skinSmooth');
    expect(kinds(doc)).toEqual(['grain']);
    expect(kinds(base)).toEqual(['skinSmooth', 'grain']);
  });

  it('returns the same document when the kind is absent', () => {
    const base = createDocument([createLayer('grain')]);
    expect(removeLayer(base, 'adjust')).toBe(base);
  });
});

describe('resetLayer', () => {
  it('restores default params and keeps id, enabled and opacity', () => {
    const base = upsertLayer(createDocument(), 'adjust', {
      params: { exposure: 1, tint: -0.5 },
      enabled: false,
      opacity: 0.3,
    });
    const before = getLayer(base, 'adjust')!;
    const doc = resetLayer(base, 'adjust');
    const after = getLayer(doc, 'adjust')!;
    expect(after).toEqual({ ...before, params: DEFAULT_PARAMS.adjust });
    expect(after.params).not.toBe(DEFAULT_PARAMS.adjust);
    expect(getLayer(base, 'adjust')?.params.exposure).toBe(1);
  });

  it('is a no-op when the layer is absent or already default', () => {
    const empty = createDocument();
    expect(resetLayer(empty, 'adjust')).toBe(empty);
    const defaults = createDocument([createLayer('adjust')]);
    expect(resetLayer(defaults, 'adjust')).toBe(defaults);
  });
});

describe('normalizeLayers', () => {
  it('returns [] for non-array input', () => {
    for (const junk of [null, undefined, 42, 'layers', { kind: 'grain' }]) {
      expect(normalizeLayers(junk as never)).toEqual([]);
    }
  });

  it('drops non-objects, unknown kinds and non-string kinds', () => {
    const layers = normalizeLayers([
      null,
      undefined,
      7,
      'grain',
      ['grain'],
      { kind: 'blur', params: { amount: 1 } },
      { kind: 42 },
      { kind: 'toString' },
      { params: { amount: 1 } },
      { kind: 'grain', params: { amount: 0.2 } },
    ]);
    expect(kinds(layers)).toEqual(['grain']);
    expect(layers[0]!.params).toEqual({ amount: 0.2, size: DEFAULT_PARAMS.grain.size });
  });

  it('keeps the last layer of each kind and sorts by stage', () => {
    const layers = normalizeLayers([
      { kind: 'transform', id: 't' },
      { kind: 'grain', id: 'g1', params: { amount: 0.1 } },
      { kind: 'skinSmooth', id: 's' },
      { kind: 'grain', id: 'g2', params: { amount: 0.9 } },
      { kind: 'filter', id: 'f' },
    ]);
    expect(layers.map((l) => l.id)).toEqual(['s', 'f', 'g2', 't']);
    expect(layers[2]!.params).toMatchObject({ amount: 0.9 });
  });

  it('fills every missing field with defaults', () => {
    const [layer] = normalizeLayers([{ kind: 'adjust' }]);
    expect(layer).toMatchObject({ kind: 'adjust', enabled: true, opacity: 1, params: DEFAULT_PARAMS.adjust });
    expect(typeof layer!.id).toBe('string');
    expect(layer!.id.length).toBeGreaterThan(0);
  });

  it('replaces hostile numbers with defaults and clamps out-of-range ones', () => {
    const [layer] = normalizeLayers([
      {
        kind: 'adjust',
        params: {
          exposure: NaN,
          contrast: Infinity,
          highlights: '0.5',
          shadows: { value: 1 },
          saturation: 7,
          vibrance: -7,
          temperature: null,
          tint: 0.25,
        },
      },
    ]);
    expect(layer!.params).toEqual({ ...DEFAULT_PARAMS.adjust, saturation: 1, vibrance: -1, tint: 0.25 });
  });

  it('drops unknown param keys, including prototype keys from JSON', () => {
    const raw = JSON.parse('[{"kind":"grain","params":{"amount":0.4,"bogus":1,"__proto__":{"polluted":true}}}]');
    const [layer] = normalizeLayers(raw);
    expect(Object.keys(layer!.params).sort()).toEqual(['amount', 'size']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(layer!.params)).toBe(Object.prototype);
  });

  it('uses defaults when params is not an object', () => {
    for (const params of [null, 'x', 3, [0.5, 0.5], true]) {
      const [layer] = normalizeLayers([{ kind: 'skinSmooth', params }]);
      expect(layer!.params).toEqual(DEFAULT_PARAMS.skinSmooth);
    }
  });

  it('validates filter lookId', () => {
    for (const lookId of ['', '   ', 5, null, ['film'], { id: 'film' }]) {
      const [layer] = normalizeLayers([{ kind: 'filter', params: { lookId, intensity: 0.5 } }]);
      expect(layer!.params).toEqual({ lookId: DEFAULT_PARAMS.filter.lookId, intensity: 0.5 });
    }
    const [custom] = normalizeLayers([{ kind: 'filter', params: { lookId: 'custom:abc' } }]);
    expect(custom!.params).toMatchObject({ lookId: 'custom:abc' });
  });

  it('validates transform rotate and flips', () => {
    for (const rotate of [45, -90, 360, '90', NaN, null]) {
      const [layer] = normalizeLayers([{ kind: 'transform', params: { rotate } }]);
      expect(layer!.params).toMatchObject({ rotate: 0 });
    }
    for (const rotate of [0, 90, 180, 270]) {
      const [layer] = normalizeLayers([{ kind: 'transform', params: { rotate } }]);
      expect(layer!.params).toMatchObject({ rotate });
    }
    const [flipped] = normalizeLayers([{ kind: 'transform', params: { flipH: true, flipV: 'yes' } }]);
    expect(flipped!.params).toMatchObject({ flipH: true, flipV: false });
  });

  it('keeps a valid crop and copies it', () => {
    const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.6, extra: 1 };
    const [layer] = normalizeLayers([{ kind: 'transform', params: { crop } }]);
    expect(layer!.params).toMatchObject({ crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } });
    expect(layer!.kind === 'transform' && layer!.params.crop).not.toBe(crop);
  });

  it('clamps a crop into the unit square', () => {
    const cases: [unknown, { x: number; y: number; width: number; height: number }][] = [
      [{ x: -0.5, y: -0.5, width: 0.3, height: 0.3 }, { x: 0, y: 0, width: 0.3, height: 0.3 }],
      [{ x: 0.9, y: 0.95, width: 0.3, height: 0.2 }, { x: 0.7, y: 0.8, width: 0.3, height: 0.2 }],
      [{ x: 0, y: 0, width: 5, height: 2 }, { x: 0, y: 0, width: 1, height: 1 }],
      [{ x: 1, y: 1, width: 0, height: -1 }, { x: 1 - MIN_CROP_SIZE, y: 1 - MIN_CROP_SIZE, width: MIN_CROP_SIZE, height: MIN_CROP_SIZE }],
    ];
    for (const [crop, expected] of cases) {
      const [layer] = normalizeLayers([{ kind: 'transform', params: { crop } }]);
      if (layer?.kind !== 'transform') throw new Error('expected a transform layer');
      const result = layer.params.crop!;
      expect(result.x).toBeCloseTo(expected.x, 12);
      expect(result.y).toBeCloseTo(expected.y, 12);
      expect(result.width).toBeCloseTo(expected.width, 12);
      expect(result.height).toBeCloseTo(expected.height, 12);
      expect(result.x + result.width).toBeLessThanOrEqual(1);
      expect(result.y + result.height).toBeLessThanOrEqual(1);
      expect(result.width).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
      expect(result.height).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
    }
  });

  it('keeps crops that already fit exactly, including ones touching the edge', () => {
    for (const crop of [
      { x: 0.1, y: 0.1, width: 0.9, height: 0.9 },
      { x: 0.3, y: 0.7, width: 0.7, height: 0.3 },
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0.99, y: 0, width: MIN_CROP_SIZE, height: 0.2 },
    ]) {
      expect(crop.x + crop.width).toBeLessThanOrEqual(1);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1);
      expect(coerceParam('transform', 'crop', crop)).toEqual({ value: crop, clamped: false });
    }
  });

  it('always yields a crop inside the unit square (fuzzed)', () => {
    let seed = 12345;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 2000; i++) {
      const raw = { x: random() * 3 - 1, y: random() * 3 - 1, width: random() * 1.5 - 0.2, height: random() * 1.5 - 0.2 };
      const result = coerceParam('transform', 'crop', raw);
      const crop = result!.value as { x: number; y: number; width: number; height: number };
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.width).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
      expect(crop.height).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
      expect(crop.x + crop.width).toBeLessThanOrEqual(1);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1);
      expect(result!.clamped).toBe(
        crop.x !== raw.x || crop.y !== raw.y || crop.width !== raw.width || crop.height !== raw.height,
      );
    }
  });

  it('rejects malformed crops', () => {
    for (const crop of [
      { x: 0, y: 0, width: NaN, height: 0.5 },
      { x: 0, y: 0, width: 0.5 },
      { x: '0', y: 0, width: 0.5, height: 0.5 },
      [0, 0, 0.5, 0.5],
      'full',
      0,
    ]) {
      const [layer] = normalizeLayers([{ kind: 'transform', params: { crop } }]);
      expect(layer!.params).toMatchObject({ crop: null });
    }
  });

  it('validates enabled and opacity', () => {
    const cases: [unknown, unknown, boolean, number][] = [
      [false, 0.5, false, 0.5],
      ['false', NaN, true, 1],
      [0, '0.5', true, 1],
      [undefined, 2, true, 1],
      [null, -3, true, 0],
      [true, Infinity, true, 1],
    ];
    for (const [enabled, opacity, expectedEnabled, expectedOpacity] of cases) {
      const [layer] = normalizeLayers([{ kind: 'grain', enabled, opacity }]);
      expect(layer).toMatchObject({ enabled: expectedEnabled, opacity: expectedOpacity });
    }
  });

  it('keeps string ids, replaces missing ones and de-duplicates them', () => {
    const layers = normalizeLayers([
      { kind: 'skinSmooth', id: 'same' },
      { kind: 'grain', id: 'same' },
      { kind: 'adjust', id: '' },
      { kind: 'filter', id: 12 },
      { kind: 'sharpen' },
    ]);
    const ids = layers.map((l) => l.id);
    expect(ids[0]).toBe('same');
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(typeof id === 'string' && id.length > 0).toBe(true);
  });

  it('does not mutate or alias its input', () => {
    const raw = deepFreeze([
      { kind: 'transform', id: 't', params: { rotate: 90, flipH: false, flipV: false, crop: { x: 0, y: 0, width: 1, height: 1 } } },
      { kind: 'grain', id: 'g', params: { amount: 3 } },
    ]);
    const snapshot = structuredClone(raw);
    const layers = normalizeLayers(raw);
    expect(raw).toEqual(snapshot);
    expect(layers[0]).not.toBe(raw[1]);
    expect(layers[0]!.params).not.toBe(raw[1]!.params);
    expect(layers[1]!.kind === 'transform' && layers[1]!.params.crop).not.toBe(raw[0]!.params.crop);
  });

  it('round-trips a normalised document through JSON unchanged', () => {
    const doc = createDocument([
      createLayer('skinSmooth', { amount: 0.4 }),
      createLayer('filter', { lookId: 'film', intensity: 0.6 }),
      createLayer('transform', { rotate: 180, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }),
    ]);
    expect(normalizeLayers(JSON.parse(JSON.stringify(doc.layers)))).toEqual(doc.layers);
  });
});

describe('isDocumentIdentity', () => {
  it('is true for empty and all-default documents', () => {
    expect(isDocumentIdentity(createDocument())).toBe(true);
    expect(isDocumentIdentity(createDocument(LAYER_KINDS.map((kind) => createLayer(kind) as AnyLayer)))).toBe(true);
  });

  it('is false when any layer changes the image', () => {
    const doc = createDocument([createLayer('grain'), createLayer('skinWhiten', { amount: 0.3 })]);
    expect(isDocumentIdentity(doc)).toBe(false);
  });

  it('treats disabled, transparent and "original" filter layers as identity', () => {
    let doc = upsertLayer(createDocument(), 'skinWhiten', { params: { amount: 0.3 }, enabled: false });
    doc = upsertLayer(doc, 'grain', { params: { amount: 0.5 }, opacity: 0 });
    doc = upsertLayer(doc, 'filter', { params: { lookId: 'original', intensity: 1 } });
    expect(isDocumentIdentity(doc)).toBe(true);
    expect(isDocumentIdentity(upsertLayer(doc, 'transform', { params: { flipV: true } }))).toBe(false);
  });
});
