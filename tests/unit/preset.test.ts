import { describe, expect, it } from 'vitest';
import { createDocument, createLayer, getLayer, upsertLayer, type EditDocument } from '../../src/engine/document';
import {
  BUILTIN_PRESETS,
  PRESET_FORMAT,
  PRESET_VERSION,
  applyPreset,
  documentToPreset,
  parsePreset,
  type ParsePresetResult,
  type Preset,
} from '../../src/engine/preset';
import { DEFAULT_PARAMS, FACE_DEPENDENT_KINDS, PARAM_SPECS, isIdentityLayer, type AnyLayer } from '../../src/engine/types';

/** Look ids every looks implementation must provide (docs/ARCHITECTURE.md). */
const REQUIRED_LOOK_IDS = [
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

const BEAUTY_KINDS = new Set(['skinSmooth', 'skinWhiten', 'teethWhiten', 'faceReshape']);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function expectOk(result: ParsePresetResult): { preset: Preset; warnings: string[] } {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result;
}

function expectError(result: ParsePresetResult): string {
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

function preset(layers: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { format: PRESET_FORMAT, version: PRESET_VERSION, name: 'Test', layers, ...extra };
}

function withoutIds(layers: readonly AnyLayer[]): Omit<AnyLayer, 'id'>[] {
  return layers.map(({ id: _id, ...rest }) => rest);
}

function sampleDocument(): EditDocument {
  let doc = createDocument();
  doc = upsertLayer(doc, 'skinSmooth', { params: { amount: 0.45, detail: 0.2 } });
  doc = upsertLayer(doc, 'skinWhiten', { params: { amount: 0.2 }, opacity: 0.6 });
  doc = upsertLayer(doc, 'teethWhiten', { params: { amount: 0.9 }, enabled: false });
  doc = upsertLayer(doc, 'faceReshape', { params: { slim: 0.3, chin: -0.25 } });
  doc = upsertLayer(doc, 'adjust', { params: { exposure: 0.3, temperature: -0.2 } });
  doc = upsertLayer(doc, 'filter', { params: { lookId: 'film', intensity: 0.7 } });
  doc = upsertLayer(doc, 'sharpen', {});
  doc = upsertLayer(doc, 'grain', { params: { amount: 0.4 }, opacity: 0 });
  doc = upsertLayer(doc, 'transform', { params: { rotate: 90, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } } });
  return doc;
}

describe('documentToPreset', () => {
  it('stores only image-changing, non-transform layers without ids', () => {
    const result = documentToPreset(sampleDocument(), 'My look');
    expect(result.format).toBe(PRESET_FORMAT);
    expect(result.version).toBe(PRESET_VERSION);
    expect(result.name).toBe('My look');
    expect(result.layers.map((l) => l.kind)).toEqual(['skinSmooth', 'skinWhiten', 'faceReshape', 'adjust', 'filter']);
    for (const layer of result.layers) {
      expect(layer).not.toHaveProperty('id');
      expect(layer).not.toHaveProperty('enabled');
    }
  });

  it('stores full params and opacity only when below 1', () => {
    const result = documentToPreset(sampleDocument(), 'x');
    expect(result.layers[0]).toEqual({ kind: 'skinSmooth', params: { amount: 0.45, detail: 0.2 } });
    expect(result.layers[1]).toEqual({ kind: 'skinWhiten', opacity: 0.6, params: { amount: 0.2 } });
    expect(result.layers[3]!.params).toEqual({ ...DEFAULT_PARAMS.adjust, exposure: 0.3, temperature: -0.2 });
  });

  it('copies params instead of aliasing the document', () => {
    const doc = sampleDocument();
    const result = documentToPreset(doc, 'x');
    expect(result.layers[0]!.params).not.toBe(getLayer(doc, 'skinSmooth')!.params);
  });

  it('falls back to a default name for blank names', () => {
    expect(documentToPreset(createDocument(), '   ').name).toBe('Untitled');
    expect(documentToPreset(createDocument(), '  Soft  ').name).toBe('Soft');
  });

  it('produces an empty preset for an identity document', () => {
    expect(documentToPreset(createDocument([createLayer('adjust'), createLayer('transform')]), 'x').layers).toEqual([]);
  });
});

describe('preset round trip', () => {
  it('reproduces the look through JSON on a fresh document', () => {
    const doc = sampleDocument();
    const json = JSON.stringify(documentToPreset(doc, 'Round trip'));
    const { preset: parsed, warnings } = expectOk(parsePreset(json));
    expect(warnings).toEqual([]);
    const applied = applyPreset(createDocument(), parsed);
    const expected = doc.layers.filter((l) => l.kind !== 'transform' && !isIdentityLayer(l));
    expect(withoutIds(applied.layers)).toEqual(withoutIds(expected));
  });

  it('parses its own output to an equal preset', () => {
    const original = documentToPreset(sampleDocument(), 'Same');
    const { preset: parsed } = expectOk(parsePreset(original));
    expect(parsed).toEqual(original);
  });
});

describe('parsePreset errors', () => {
  it('rejects invalid JSON', () => {
    expect(expectError(parsePreset('{"format": '))).toMatch(/^Invalid JSON/);
    expect(expectError(parsePreset(''))).toMatch(/^Invalid JSON/);
  });

  it('rejects non-objects', () => {
    for (const input of [null, undefined, 42, true, [], '[]', '"preset"', '3']) {
      expect(expectError(parsePreset(input))).toMatch(/must be a JSON object/);
    }
  });

  it('rejects other formats', () => {
    expect(expectError(parsePreset({ version: 1, layers: [] }))).toMatch(/Not an OpenMeitu preset/);
    expect(expectError(parsePreset(preset([], { format: 'other.preset' })))).toMatch(/Not an OpenMeitu preset/);
  });

  it('rejects future versions with an upgrade hint', () => {
    const error = expectError(parsePreset(preset([], { version: PRESET_VERSION + 1 })));
    expect(error).toMatch(/newer/);
    expect(error).toMatch(/update/i);
  });

  it('rejects invalid versions', () => {
    for (const version of [0, -1, 1.5, '1', null, undefined]) {
      expect(expectError(parsePreset(preset([], { version })))).toMatch(/Invalid preset version/);
    }
  });

  it('rejects a missing or non-array layers field', () => {
    for (const layers of [undefined, null, {}, 'skinSmooth']) {
      expect(expectError(parsePreset(preset([], { layers })))).toMatch(/"layers" must be an array/);
    }
  });
});

describe('parsePreset warnings', () => {
  it('accepts a minimal preset without warnings', () => {
    const { preset: parsed, warnings } = expectOk(
      parsePreset('{"format":"openmeitu.preset","version":1,"name":"Soft","layers":[{"kind":"skinSmooth","params":{"amount":0.5}}]}'),
    );
    expect(warnings).toEqual([]);
    expect(parsed).toEqual({
      format: PRESET_FORMAT,
      version: 1,
      name: 'Soft',
      layers: [{ kind: 'skinSmooth', params: { amount: 0.5 } }],
    });
  });

  it('accepts a UTF-8 byte order mark', () => {
    const json = `\uFEFF${JSON.stringify(preset([]))}`;
    expect(json.charCodeAt(0)).toBe(0xfeff);
    expect(expectOk(parsePreset(json)).warnings).toEqual([]);
  });

  it('warns about and drops unknown kinds, transform layers and junk entries', () => {
    const { preset: parsed, warnings } = expectOk(
      parsePreset(
        preset([
          { kind: 'blur', params: { amount: 1 } },
          { kind: 'transform', params: { rotate: 90 } },
          null,
          'grain',
          { params: {} },
          { kind: 'grain', params: { amount: 0.3 } },
        ]),
      ),
    );
    expect(parsed.layers).toEqual([{ kind: 'grain', params: { amount: 0.3 } }]);
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toMatch(/Layer 1.*unknown layer kind "blur"/);
    expect(warnings[1]).toMatch(/Layer 2.*transform.*per-photo/);
    expect(warnings[2]).toMatch(/Layer 3 is not an object/);
    expect(warnings[3]).toMatch(/Layer 4 is not an object/);
    expect(warnings[4]).toMatch(/Layer 5.*unknown layer kind undefined/);
  });

  it('warns about unknown params, invalid values and clamps', () => {
    const { preset: parsed, warnings } = expectOk(
      parsePreset(preset([{ kind: 'adjust', params: { exposure: 9, contrast: '0.2', glow: 1, saturation: -0.3 } }])),
    );
    expect(parsed.layers).toEqual([{ kind: 'adjust', params: { exposure: PARAM_SPECS.adjust.exposure.max, saturation: -0.3 } }]);
    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => /"exposure" 9 is out of range; clamped to 2/.test(w))).toBe(true);
    expect(warnings.some((w) => /invalid value "0.2" for "contrast"/.test(w))).toBe(true);
    expect(warnings.some((w) => /unknown parameter "glow"/.test(w))).toBe(true);
  });

  it('warns about invalid lookIds', () => {
    const { preset: parsed, warnings } = expectOk(parsePreset(preset([{ kind: 'filter', params: { lookId: '', intensity: 0.5 } }])));
    expect(parsed.layers).toEqual([{ kind: 'filter', params: { intensity: 0.5 } }]);
    expect(warnings).toEqual([expect.stringMatching(/invalid value "" for "lookId"/)]);
  });

  it('validates enabled and opacity', () => {
    const { preset: parsed, warnings } = expectOk(
      parsePreset(
        preset([
          { kind: 'skinSmooth', enabled: 'yes', opacity: 1.5, params: {} },
          { kind: 'grain', enabled: false, opacity: '0.5', params: {} },
        ]),
      ),
    );
    expect(parsed.layers).toEqual([
      { kind: 'skinSmooth', opacity: 1, params: {} },
      { kind: 'grain', enabled: false, params: {} },
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => /"enabled" must be true or false/.test(w))).toBe(true);
    expect(warnings.some((w) => /opacity 1.5 is out of range; clamped to 1/.test(w))).toBe(true);
    expect(warnings.some((w) => /invalid opacity "0.5"/.test(w))).toBe(true);
  });

  it('warns when params is not an object and treats a missing one as empty', () => {
    const { preset: parsed, warnings } = expectOk(
      parsePreset(preset([{ kind: 'skinSmooth', params: [0.5] }, { kind: 'grain' }])),
    );
    expect(parsed.layers).toEqual([
      { kind: 'skinSmooth', params: {} },
      { kind: 'grain', params: {} },
    ]);
    expect(warnings).toEqual([expect.stringMatching(/"params" must be an object, got an array/)]);
  });

  it('keeps the last of duplicate kinds and returns layers in stage order', () => {
    const { preset: parsed, warnings } = expectOk(
      parsePreset(
        preset([
          { kind: 'grain', params: { amount: 0.1 } },
          { kind: 'skinSmooth', params: { amount: 0.2 } },
          { kind: 'grain', params: { amount: 0.5 } },
        ]),
      ),
    );
    expect(parsed.layers).toEqual([
      { kind: 'skinSmooth', params: { amount: 0.2 } },
      { kind: 'grain', params: { amount: 0.5 } },
    ]);
    expect(warnings).toEqual([expect.stringMatching(/Layer 3: duplicate "grain"/)]);
  });

  it('defaults a missing name and validates localised names', () => {
    const unnamed = expectOk(parsePreset(preset([], { name: '  ', names: { zh: 7, fr: 'Doux' } })));
    expect(unnamed.preset.name).toBe('Untitled');
    expect(unnamed.preset).not.toHaveProperty('names');
    expect(unnamed.warnings).toHaveLength(2);
    expect(unnamed.warnings.some((w) => /no name/.test(w))).toBe(true);
    expect(unnamed.warnings.some((w) => /"names.zh"/.test(w))).toBe(true);

    const localised = expectOk(parsePreset(preset([], { name: ' Mine ', names: { en: ' Soft ', zh: '', fr: 'Doux' } })));
    expect(localised.preset.name).toBe('Mine');
    expect(localised.preset.names).toEqual({ en: 'Soft' });
    expect(localised.warnings).toEqual([expect.stringMatching(/"names.zh" must be a non-empty string/)]);

    const junkNames = expectOk(parsePreset(preset([], { names: 'Soft' })));
    expect(junkNames.preset).not.toHaveProperty('names');
    expect(junkNames.warnings).toEqual([expect.stringMatching(/"names" must be an object/)]);
  });

  it('falls back to a localised name when "name" is missing', () => {
    const english = expectOk(parsePreset(preset([], { name: undefined, names: { en: 'Soft', zh: '柔和' } })));
    expect(english.preset.name).toBe('Soft');
    expect(english.warnings).toEqual([]);

    const chinese = expectOk(parsePreset(preset([], { name: 3, names: { zh: '柔和' } })));
    expect(chinese.preset.name).toBe('柔和');
    expect(chinese.warnings).toEqual([]);
  });

  it('ignores unknown top-level fields', () => {
    const result = expectOk(parsePreset(preset([], { author: 'someone', description: 'x' })));
    expect(result.warnings).toEqual([]);
    expect(result.preset).not.toHaveProperty('author');
  });

  it('is immune to prototype keys in JSON', () => {
    const json =
      '{"format":"openmeitu.preset","version":1,"name":"P","__proto__":{"polluted":1},' +
      '"layers":[{"kind":"grain","params":{"__proto__":{"polluted":1},"amount":0.2}}]}';
    const { preset: parsed, warnings } = expectOk(parsePreset(json));
    expect(parsed.layers).toEqual([{ kind: 'grain', params: { amount: 0.2 } }]);
    expect(Object.getPrototypeOf(parsed.layers[0]!.params)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(warnings).toEqual([expect.stringMatching(/unknown parameter "__proto__"/)]);
  });

  it('truncates long untrusted strings in warnings', () => {
    const { warnings } = expectOk(parsePreset(preset([{ kind: 'x'.repeat(10_000) }])));
    expect(warnings[0]!.length).toBeLessThan(120);
  });

  it('describes non-JSON values in object input by type, never by their source', () => {
    const secret = 'x'.repeat(500);
    const amount = () => secret;
    const { preset: parsed, warnings } = expectOk(
      parsePreset(preset([{ kind: 'grain', params: { amount, size: Symbol('s'), extra: 1 } }])),
    );
    expect(parsed.layers).toEqual([{ kind: 'grain', params: {} }]);
    expect(warnings).toEqual([
      expect.stringMatching(/invalid value a function for "amount"/),
      expect.stringMatching(/invalid value a symbol for "size"/),
      expect.stringMatching(/unknown parameter "extra"/),
    ]);
    for (const warning of warnings) expect(warning).not.toContain(secret);
  });

  it('does not mutate an object input', () => {
    const input = deepFreeze(preset([{ kind: 'grain', params: { amount: 5, junk: 1 } }]));
    const snapshot = structuredClone(input);
    expectOk(parsePreset(input));
    expect(input).toEqual(snapshot);
  });
});

describe('applyPreset', () => {
  const soft = expectOk(
    parsePreset(
      preset([
        { kind: 'skinSmooth', params: { amount: 0.5 } },
        { kind: 'filter', opacity: 0.8, params: { lookId: 'fresh' } },
      ]),
    ),
  ).preset;

  it('replace drops other layers, keeps transform and fills defaults', () => {
    const doc = sampleDocument();
    const transform = getLayer(doc, 'transform');
    const result = applyPreset(doc, soft);
    expect(result.layers.map((l) => l.kind)).toEqual(['skinSmooth', 'filter', 'transform']);
    expect(getLayer(result, 'skinSmooth')).toMatchObject({
      enabled: true,
      opacity: 1,
      params: { amount: 0.5, detail: DEFAULT_PARAMS.skinSmooth.detail },
    });
    expect(getLayer(result, 'filter')).toMatchObject({
      opacity: 0.8,
      params: { lookId: 'fresh', intensity: DEFAULT_PARAMS.filter.intensity },
    });
    expect(getLayer(result, 'transform')).toBe(transform);
  });

  it('replace is the default mode', () => {
    const doc = sampleDocument();
    expect(applyPreset(doc, soft)).toEqual(applyPreset(doc, soft, 'replace'));
  });

  it('replace re-enables layers and reuses their ids', () => {
    const doc = upsertLayer(createDocument(), 'skinSmooth', { params: { amount: 0.1, detail: 0.9 }, enabled: false, opacity: 0.2 });
    const result = applyPreset(doc, soft);
    expect(getLayer(result, 'skinSmooth')).toEqual({
      ...getLayer(doc, 'skinSmooth'),
      enabled: true,
      opacity: 1,
      params: { amount: 0.5, detail: DEFAULT_PARAMS.skinSmooth.detail },
    });
  });

  it('returns the same document when re-applying a preset', () => {
    const once = applyPreset(sampleDocument(), soft);
    expect(applyPreset(once, soft)).toBe(once);
    expect(applyPreset(once, soft, 'merge')).toBe(once);
  });

  it('merge keeps other layers and unspecified params', () => {
    const doc = sampleDocument();
    const result = applyPreset(doc, soft, 'merge');
    expect(result.layers.map((l) => l.kind)).toEqual(doc.layers.map((l) => l.kind));
    expect(getLayer(result, 'skinSmooth')).toMatchObject({
      id: getLayer(doc, 'skinSmooth')!.id,
      params: { amount: 0.5, detail: 0.2 },
    });
    expect(getLayer(result, 'filter')).toMatchObject({ opacity: 0.8, params: { lookId: 'fresh', intensity: 0.7 } });
    expect(getLayer(result, 'adjust')).toBe(getLayer(doc, 'adjust'));
    expect(getLayer(result, 'transform')).toBe(getLayer(doc, 'transform'));
  });

  it('merge adds missing layers in stage order', () => {
    const doc = createDocument([createLayer('grain', { amount: 0.2 })]);
    const result = applyPreset(doc, soft, 'merge');
    expect(result.layers.map((l) => l.kind)).toEqual(['skinSmooth', 'filter', 'grain']);
  });

  it('replace keeps the current layers of `keep` kinds the preset does not set', () => {
    const doc = sampleDocument();
    const result = applyPreset(doc, soft, 'replace', { keep: ['faceReshape', 'teethWhiten'] });
    expect(result.layers.map((l) => l.kind)).toEqual(['skinSmooth', 'teethWhiten', 'faceReshape', 'filter', 'transform']);
    expect(getLayer(result, 'faceReshape')).toBe(getLayer(doc, 'faceReshape'));
    expect(getLayer(result, 'teethWhiten')).toBe(getLayer(doc, 'teethWhiten'));
  });

  it('replace still applies a `keep` kind the preset sets', () => {
    const reshape = expectOk(parsePreset(preset([{ kind: 'faceReshape', params: { eyes: 0.2 } }]))).preset;
    const result = applyPreset(sampleDocument(), reshape, 'replace', { keep: ['faceReshape'] });
    expect(getLayer(result, 'faceReshape')?.params).toEqual({ ...DEFAULT_PARAMS.faceReshape, eyes: 0.2 });
    expect(result.layers.map((l) => l.kind)).toEqual(['faceReshape', 'transform']);
  });

  it('honours enabled: false from the preset', () => {
    const disabled = expectOk(parsePreset(preset([{ kind: 'grain', enabled: false, params: { amount: 0.4 } }]))).preset;
    expect(getLayer(applyPreset(createDocument(), disabled), 'grain')?.enabled).toBe(false);
  });

  it('an empty preset in replace mode clears everything except transform', () => {
    const empty = expectOk(parsePreset(preset([]))).preset;
    const result = applyPreset(sampleDocument(), empty);
    expect(result.layers.map((l) => l.kind)).toEqual(['transform']);
  });

  it('ignores transform and unknown layers in hand-made presets', () => {
    const handMade = {
      format: PRESET_FORMAT,
      version: PRESET_VERSION,
      name: 'Hand made',
      layers: [
        { kind: 'transform', params: { rotate: 180 } },
        { kind: 'blur', params: { amount: 1 } },
        { kind: 'grain', params: { amount: 9, junk: true } },
      ],
    } as unknown as Preset;
    const doc = sampleDocument();
    for (const mode of ['replace', 'merge'] as const) {
      const result = applyPreset(doc, handMade, mode);
      expect(getLayer(result, 'transform')).toBe(getLayer(doc, 'transform'));
      expect(getLayer(result, 'grain')?.params).toEqual({ ...DEFAULT_PARAMS.grain, amount: 1 });
    }
  });

  it('treats invalid enabled/opacity in unparsed presets as the defaults', () => {
    const base = upsertLayer(createDocument(), 'grain', { params: { amount: 0.2 }, enabled: false, opacity: 0.3 });
    const handMade = {
      format: PRESET_FORMAT,
      version: PRESET_VERSION,
      name: 'Hand made',
      layers: [{ kind: 'grain', enabled: 'yes', opacity: NaN, params: { amount: 0.5 } }],
    } as unknown as Preset;
    for (const mode of ['replace', 'merge'] as const) {
      expect(getLayer(applyPreset(base, handMade, mode), 'grain')).toMatchObject({
        enabled: true,
        opacity: 1,
        params: { amount: 0.5 },
      });
    }
  });

  it('clamps out-of-range opacity in unparsed presets', () => {
    const handMade = {
      format: PRESET_FORMAT,
      version: PRESET_VERSION,
      name: 'Hand made',
      layers: [{ kind: 'grain', opacity: 4, params: { amount: 0.5 } }],
    } as unknown as Preset;
    expect(getLayer(applyPreset(createDocument(), handMade), 'grain')?.opacity).toBe(1);
  });

  it('never mutates the document or the preset', () => {
    const doc = deepFreeze(sampleDocument());
    const frozenPreset = deepFreeze(structuredClone(soft));
    const docSnapshot = structuredClone(doc);
    applyPreset(doc, frozenPreset, 'replace');
    applyPreset(doc, frozenPreset, 'merge');
    expect(doc).toEqual(docSnapshot);
    expect(frozenPreset).toEqual(soft);
  });
});

describe('BUILTIN_PRESETS', () => {
  it('ships six presets with unique English and Chinese names', () => {
    expect(BUILTIN_PRESETS).toHaveLength(6);
    const en = BUILTIN_PRESETS.map((p) => p.names?.en);
    const zh = BUILTIN_PRESETS.map((p) => p.names?.zh);
    expect(en).toEqual(['Natural', 'Clear', 'Glow', 'Refined', 'Film', 'Monochrome']);
    expect(zh).toEqual(['自然', '清透', '元气', '精致', '胶片', '黑白']);
    expect(BUILTIN_PRESETS.map((p) => p.name)).toEqual(en);
  });

  it.each(BUILTIN_PRESETS.map((p) => [p.name, p] as const))('%s parses from JSON with zero warnings', (_name, builtin) => {
    const { preset: parsed, warnings } = expectOk(parsePreset(JSON.stringify(builtin)));
    expect(warnings).toEqual([]);
    expect(parsed).toEqual(builtin);
  });

  it.each(BUILTIN_PRESETS.map((p) => [p.name, p] as const))('%s keeps beauty amounts natural-looking', (_name, builtin) => {
    for (const layer of builtin.layers) {
      expect(layer.kind).not.toBe('transform');
      if (!BEAUTY_KINDS.has(layer.kind)) continue;
      for (const [key, value] of Object.entries(layer.params)) {
        if (key === 'detail') continue;
        expect(Math.abs(value as number), `${layer.kind}.${key}`).toBeLessThanOrEqual(0.6);
      }
    }
  });

  it.each(BUILTIN_PRESETS.map((p) => [p.name, p] as const))('%s references only required look ids', (_name, builtin) => {
    const filter = builtin.layers.find((l) => l.kind === 'filter');
    expect(filter).toBeDefined();
    expect(REQUIRED_LOOK_IDS).toContain(filter!.params.lookId);
    expect(filter!.params.lookId).not.toBe('original');
  });

  it.each(BUILTIN_PRESETS.map((p) => [p.name, p] as const))('%s visibly changes the image without a face', (_name, builtin) => {
    const doc = applyPreset(createDocument(), builtin);
    const faceFree = doc.layers.filter((l) => !FACE_DEPENDENT_KINDS.includes(l.kind));
    expect(faceFree.some((l) => !isIdentityLayer(l))).toBe(true);
  });

  it('presets are distinct', () => {
    const serialised = new Set(BUILTIN_PRESETS.map((p) => JSON.stringify(p.layers)));
    expect(serialised.size).toBe(BUILTIN_PRESETS.length);
  });

  it('are deeply frozen', () => {
    for (const builtin of BUILTIN_PRESETS) {
      expect(Object.isFrozen(builtin)).toBe(true);
      expect(Object.isFrozen(builtin.layers)).toBe(true);
      expect(Object.isFrozen(builtin.names)).toBe(true);
      for (const layer of builtin.layers) {
        expect(Object.isFrozen(layer)).toBe(true);
        expect(Object.isFrozen(layer.params)).toBe(true);
      }
    }
    expect(Object.isFrozen(BUILTIN_PRESETS)).toBe(true);
  });
});
