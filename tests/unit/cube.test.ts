import { describe, expect, it } from 'vitest';
import { parseCube, resampleLut, sampleLut, serializeCube } from '../../src/filters/cube';
import { getLook } from '../../src/filters/looks';
import { buildLut, identityLut, type LutData } from '../../src/filters/lut';

/** Lattice inputs in .cube order: red fastest, then green, then blue. */
function lattice(size: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) out.push([r / (size - 1), g / (size - 1), b / (size - 1)]);
    }
  }
  return out;
}

function cubeFile(size: number, entries: string[], header: string[] = []): string {
  return [...header, `LUT_3D_SIZE ${size}`, ...entries].join('\n');
}

const IDENTITY_2 = lattice(2).map((c) => c.join(' '));

describe('parseCube', () => {
  it('parses titles, comments, blank lines and CRLF line endings', () => {
    const text = [
      '# Created by a test',
      'TITLE "Identity # two"',
      '',
      'LUT_3D_SIZE 2',
      '   ',
      ...IDENTITY_2.slice(0, 4),
      '# a comment between entries',
      ...IDENTITY_2.slice(4),
      '',
    ].join('\r\n');
    const lut = parseCube(text);
    expect(lut.size).toBe(2);
    expect(lut.title).toBe('Identity # two');
    expect(lut.data).toEqual(identityLut(2).data);
    expect(parseCube(text.replaceAll('\r\n', '\r')).data).toEqual(identityLut(2).data);
  });

  it('reads table entries with red varying fastest', () => {
    const entries = Array.from({ length: 8 }, (_, k) => `${k / 10} 0 0`);
    const lut = parseCube(cubeFile(2, entries));
    for (let k = 0; k < 8; k++) expect(lut.data[k * 4]).toBe(Math.round((k / 10) * 255));
    expect(sampleLut(lut, 1, 0, 0)[0]).toBeCloseTo(Math.round(0.1 * 255) / 255, 9);
    expect(sampleLut(lut, 0, 1, 0)[0]).toBeCloseTo(Math.round(0.2 * 255) / 255, 9);
    expect(sampleLut(lut, 0, 0, 1)[0]).toBeCloseTo(Math.round(0.4 * 255) / 255, 9);
  });

  it('reads unquoted titles without their trailing comment', () => {
    expect(parseCube(cubeFile(2, IDENTITY_2, ['TITLE Warm grade   # v2'])).title).toBe('Warm grade');
  });

  it('accepts inline comments, signed/exponent numbers, vendor keywords and a BOM', () => {
    const entries = lattice(2).map((c) => `${c.map((v) => (v ? '1.0e0' : '+0')).join(' ')}   # entry`);
    const text = `\uFEFF${cubeFile(2, entries, ['LUT_IN_VIDEO_RANGE', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'])}`;
    expect(parseCube(text).data).toEqual(identityLut(2).data);
    expect(parseCube(text).title).toBeUndefined();
  });

  it('clamps output values to 0..1', () => {
    const entries = ['-0.5 1.7 0.5', ...IDENTITY_2.slice(1)];
    const lut = parseCube(cubeFile(2, entries));
    expect(Array.from(lut.data.subarray(0, 4))).toEqual([0, 255, 128, 255]);
  });

  it('rescales a DOMAIN_MIN/DOMAIN_MAX input range onto 0..1', () => {
    // Over the domain 0..2 this table outputs input/2, so on 0..1 it must output x/2.
    const half = lattice(3).map((c) => c.map((v) => (v * 2) / 2).join(' '));
    const scaled = parseCube(cubeFile(3, half, ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 2 2 2']));
    expect(scaled.data).toEqual(buildLut((r, g, b) => [r / 2, g / 2, b / 2], 3).data);

    // Over −1..1 this table outputs (input + 1) / 2.
    const shifted = lattice(5).map((c) => c.map((v) => (v * 2 - 1 + 1) / 2).join(' '));
    const expected = buildLut((r, g, b) => [(r + 1) / 2, (g + 1) / 2, (b + 1) / 2], 5).data;
    expect(parseCube(cubeFile(5, shifted, ['DOMAIN_MIN -1 -1 -1', 'DOMAIN_MAX 1 1 1'])).data).toEqual(expected);
    expect(parseCube(cubeFile(5, shifted, ['LUT_3D_INPUT_RANGE -1 1'])).data).toEqual(expected);
  });

  it('rescales each channel independently', () => {
    const table = lattice(2).map(([r, g, b]) => `${r} ${g} ${b}`);
    const lut = parseCube(cubeFile(2, table, ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 2 1 4']));
    const [r, g, b] = sampleLut(lut, 1, 1, 1);
    expect(r).toBeCloseTo(128 / 255, 9);
    expect(g).toBe(1);
    expect(b).toBeCloseTo(64 / 255, 9);
  });

  it('rejects 1D LUTs', () => {
    expect(() => parseCube('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n')).toThrow(/1D LUTs .* not supported/);
  });

  it('rejects wrong entry counts', () => {
    expect(() => parseCube(cubeFile(2, IDENTITY_2.slice(0, 7)))).toThrow(/needs 8 table entries, found 7/);
    expect(() => parseCube(cubeFile(2, [...IDENTITY_2, '0 0 0']))).toThrow(/line 10: more than 8 table entries/);
  });

  it('rejects non-numeric and malformed data', () => {
    const withLine = (line: string) => cubeFile(2, [line, ...IDENTITY_2.slice(1)]);
    expect(() => parseCube(withLine('0 abc 0'))).toThrow(/line 2: "abc" is not a number/);
    expect(() => parseCube(withLine('0 NaN 0'))).toThrow(/"NaN" is not a number/);
    expect(() => parseCube(withLine('0 0x1 0'))).toThrow(/"0x1" is not a number/);
    expect(() => parseCube(withLine('nope nope nope'))).toThrow(/line 2: expected a keyword or three numbers/);
    expect(() => parseCube(withLine('Infinity 0 0'))).toThrow(/expected a keyword or three numbers/);
    expect(() => parseCube(withLine('0 0'))).toThrow(/line 2: expected three numbers/);
    expect(() => parseCube(withLine('0 0 0 0'))).toThrow(/expected three numbers/);
    expect(() => parseCube(withLine('0 1e999 0'))).toThrow(/line 2: "1e999" is out of range/);
    expect(() => parseCube(cubeFile(2, IDENTITY_2, ['DOMAIN_MAX 1 1 1e400']))).toThrow(/line 1: "1e400" is out of range/);
  });

  it('rejects sizes outside 2..65', () => {
    for (const size of ['1', '66', '2.5', 'abc', '-3']) {
      expect(() => parseCube(`LUT_3D_SIZE ${size}\n`)).toThrow(/LUT_3D_SIZE/);
    }
    expect(() => parseCube('LUT_3D_SIZE 66\n')).toThrow(/integer from 2 to 65, got 66/);
    expect(() => parseCube('LUT_3D_SIZE\n')).toThrow(/expects one integer/);
  });

  it('rejects files without LUT_3D_SIZE and misplaced or duplicate keywords', () => {
    expect(() => parseCube('')).toThrow(/missing LUT_3D_SIZE/);
    expect(() => parseCube('TITLE "x"\n# only comments\n')).toThrow(/missing LUT_3D_SIZE/);
    expect(() => parseCube(`0 0 0\n${cubeFile(2, IDENTITY_2)}`)).toThrow(/line 1: table data before LUT_3D_SIZE/);
    expect(() => parseCube(`${cubeFile(2, IDENTITY_2)}\nDOMAIN_MIN 0 0 0`)).toThrow(/line 10: keyword DOMAIN_MIN must appear before/);
    expect(() => parseCube(`${cubeFile(2, IDENTITY_2)}\nTITLE "late"`)).toThrow(/TITLE must appear before/);
    expect(() => parseCube(`LUT_3D_SIZE 2\n${cubeFile(2, IDENTITY_2)}`)).toThrow(/line 2: duplicate LUT_3D_SIZE/);
  });

  it('rejects invalid domains', () => {
    expect(() => parseCube(cubeFile(2, IDENTITY_2, ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 0 1']))).toThrow(/DOMAIN_MAX .* must exceed DOMAIN_MIN/);
    expect(() => parseCube(cubeFile(2, IDENTITY_2, ['DOMAIN_MAX 1 1']))).toThrow(/line 1: DOMAIN_MAX expects three numbers, got "1 1"/);
    expect(() => parseCube(cubeFile(2, IDENTITY_2, ['LUT_3D_INPUT_RANGE 0']))).toThrow(/LUT_3D_INPUT_RANGE expects two numbers/);
  });
});

describe('serializeCube', () => {
  it('writes a header and one line per entry', () => {
    const text = serializeCube(identityLut(3), 'My look');
    const lines = text.split('\n');
    expect(lines.slice(0, 4)).toEqual(['TITLE "My look"', 'LUT_3D_SIZE 3', 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0']);
    expect(lines[4]).toBe('0.000000 0.000000 0.000000');
    expect(lines[5]).toBe('0.501961 0.000000 0.000000');
    expect(lines.length).toBe(4 + 27 + 1);
    expect(text.endsWith('1.000000 1.000000 1.000000\n')).toBe(true);
  });

  it('round-trips through parseCube exactly', () => {
    const luts: LutData[] = [identityLut(5), getLook('film')!.build(17), getLook('mono-contrast')!.build(2)];
    for (const lut of luts) {
      const parsed = parseCube(serializeCube(lut, 'Round trip'));
      expect(parsed.size).toBe(lut.size);
      expect(parsed.data).toEqual(lut.data);
      expect(parsed.title).toBe('Round trip');
    }
  });

  it('omits empty titles and sanitises quotes and line breaks', () => {
    expect(serializeCube(identityLut(2)).startsWith('LUT_3D_SIZE 2\n')).toBe(true);
    expect(serializeCube(identityLut(2), '  \n ').startsWith('LUT_3D_SIZE 2\n')).toBe(true);
    const text = serializeCube(identityLut(2), 'Say "hi"\nnow');
    expect(text.split('\n')[0]).toBe('TITLE "Say hi now"');
    expect(parseCube(text).title).toBe('Say hi now');
  });

  it('rejects malformed LUT data', () => {
    expect(() => serializeCube({ size: 3, data: new Uint8Array(10) })).toThrow(/does not match size 3/);
    expect(() => serializeCube({ size: 1, data: new Uint8Array(4) })).toThrow(/Invalid LUT size/);
  });
});

describe('sampleLut and resampleLut', () => {
  it('samples lattice points exactly and interpolates linearly between them', () => {
    const lut = getLook('film')!.build(5);
    const at = (r: number, g: number, b: number) => {
      const i = ((b * 5 + g) * 5 + r) * 4;
      return [lut.data[i]! / 255, lut.data[i + 1]! / 255, lut.data[i + 2]! / 255];
    };
    expect(sampleLut(lut, 0.25, 0.5, 1)).toEqual(at(1, 2, 4));
    const mid = sampleLut(lut, 0.125, 0.5, 1);
    const [a, b] = [at(0, 2, 4), at(1, 2, 4)];
    for (let c = 0; c < 3; c++) expect(mid[c]).toBeCloseTo((a[c]! + b[c]!) / 2, 12);
  });

  it('clamps inputs outside 0..1 to the cube', () => {
    const lut = getLook('warm')!.build(9);
    expect(sampleLut(lut, -1, 2, 0.5)).toEqual(sampleLut(lut, 0, 1, 0.5));
  });

  it('keeps data when resampling to the same size', () => {
    const lut = getLook('cinematic')!.build(9);
    expect(resampleLut(lut, 9).data).toEqual(lut.data);
  });

  it('resamples affine LUTs without error beyond rounding', () => {
    const affine = (r: number, g: number, b: number) => [0.1 + 0.8 * r, 0.9 - 0.5 * g, 0.2 + 0.3 * b + 0.2 * r] as const;
    const up = resampleLut(buildLut(affine, 9), 33);
    const expected = buildLut(affine, 33);
    expect(up.size).toBe(33);
    for (let i = 0; i < up.data.length; i++) expect(Math.abs(up.data[i]! - expected.data[i]!)).toBeLessThanOrEqual(1);
    const down = resampleLut(identityLut(33), 17);
    expect(down.data).toEqual(identityLut(17).data);
  });

  it('rejects invalid sizes', () => {
    expect(() => resampleLut(identityLut(5), 1)).toThrow(/Invalid LUT size/);
    expect(() => resampleLut({ size: 4, data: new Uint8Array(8) }, 8)).toThrow(/does not match size 4/);
  });
});
