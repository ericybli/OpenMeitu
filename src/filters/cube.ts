/**
 * Adobe / DaVinci Resolve `.cube` 3D LUT import and export
 * (Adobe "Cube LUT Specification" 1.0).
 *
 * File layout: optional `TITLE "..."`, keywords (`LUT_3D_SIZE N`,
 * `DOMAIN_MIN r g b`, `DOMAIN_MAX r g b`, or Resolve's
 * `LUT_3D_INPUT_RANGE min max`), then N³ lines of `r g b` output values with
 * red varying fastest, then green, then blue — the same order as LutData.
 * `#` starts a comment. Lines may end in LF, CRLF or CR.
 */
import { clamp01, type Rgb } from './color';
import { buildLut, type LutData } from './lut';

export const CUBE_MIN_SIZE = 2;
export const CUBE_MAX_SIZE = 65;

export interface CubeLut extends LutData {
  /** The file's TITLE, if present. */
  title?: string;
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const KEYWORD = /^[A-Z][A-Z0-9_]*$/;

function lineError(line: number, message: string): Error {
  return new Error(`.cube line ${line}: ${message}`);
}

/**
 * Parse a `.cube` file into an RGBA8 LUT over the 0..1 input cube.
 *
 * A non-default input domain is resampled (trilinearly) so the returned
 * lattice covers 0..1; inputs outside the file's domain clamp to its edge.
 * Output values are clamped to 0..1. Throws an Error naming the offending
 * line for 1D LUTs, malformed or non-numeric lines, sizes outside 2..65 and
 * wrong entry counts.
 */
export function parseCube(text: string): CubeLut {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let title: string | undefined;
  let size: number | undefined;
  let domainMin: Rgb = [0, 0, 0];
  let domainMax: Rgb = [1, 1, 1];
  let table: Float64Array | undefined;
  let entries = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;

    const titleMatch = /^TITLE(?:\s+(.*))?$/.exec(raw);
    if (titleMatch) {
      if (entries > 0) throw lineError(lineNo, 'TITLE must appear before the table data');
      title = parseTitle(titleMatch[1] ?? '');
      continue;
    }

    const content = raw.replace(/#.*$/, '').trim();
    const tokens = content.split(/\s+/);
    const head = tokens[0]!;

    if (/^[A-Za-z_]/.test(head)) {
      if (!KEYWORD.test(head)) throw lineError(lineNo, `expected a keyword or three numbers, got "${content}"`);
      if (entries > 0) throw lineError(lineNo, `keyword ${head} must appear before the table data`);
      switch (head) {
        case 'LUT_1D_SIZE':
          throw lineError(lineNo, '1D LUTs (LUT_1D_SIZE) are not supported; use a 3D LUT (LUT_3D_SIZE)');
        case 'LUT_3D_SIZE': {
          if (size !== undefined) throw lineError(lineNo, 'duplicate LUT_3D_SIZE');
          size = parseSize(tokens, lineNo);
          table = new Float64Array(size * size * size * 3);
          break;
        }
        case 'DOMAIN_MIN':
          domainMin = parseTriple(tokens.slice(1), lineNo, head);
          break;
        case 'DOMAIN_MAX':
          domainMax = parseTriple(tokens.slice(1), lineNo, head);
          break;
        case 'LUT_3D_INPUT_RANGE': {
          if (tokens.length !== 3) throw lineError(lineNo, `LUT_3D_INPUT_RANGE expects two numbers, got "${content}"`);
          const lo = parseNumber(tokens[1]!, lineNo);
          const hi = parseNumber(tokens[2]!, lineNo);
          domainMin = [lo, lo, lo];
          domainMax = [hi, hi, hi];
          break;
        }
        default:
          // Other vendor keywords (e.g. LUT_IN_VIDEO_RANGE) carry no data we use.
          break;
      }
      continue;
    }

    if (size === undefined || table === undefined) throw lineError(lineNo, 'table data before LUT_3D_SIZE');
    if (entries >= size * size * size) {
      throw lineError(lineNo, `more than ${size * size * size} table entries for LUT_3D_SIZE ${size}`);
    }
    const [r, g, b] = parseTriple(tokens, lineNo);
    table[entries * 3] = r;
    table[entries * 3 + 1] = g;
    table[entries * 3 + 2] = b;
    entries++;
  }

  if (size === undefined || table === undefined) throw new Error('Not a 3D .cube LUT: missing LUT_3D_SIZE');
  const expected = size * size * size;
  if (entries !== expected) {
    throw new Error(`.cube LUT_3D_SIZE ${size} needs ${expected} table entries, found ${entries}`);
  }
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c]! > domainMin[c]!)) {
      throw new Error(`.cube DOMAIN_MAX (${domainMax.join(' ')}) must exceed DOMAIN_MIN (${domainMin.join(' ')}) on every channel`);
    }
  }

  const lut = isUnitDomain(domainMin, domainMax)
    ? quantize(size, table)
    : resampleDomain(size, table, domainMin, domainMax);
  return title === undefined ? lut : { ...lut, title };
}

/** Serialize a LUT as a `.cube` file (6 decimals, which round-trips 8-bit values exactly). */
export function serializeCube(lut: LutData, title?: string): string {
  assertLut(lut);
  const { size, data } = lut;
  const lines: string[] = [];
  const cleanTitle = title?.replace(/["\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (cleanTitle) lines.push(`TITLE "${cleanTitle}"`);
  lines.push(`LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0');
  for (let i = 0; i < data.length; i += 4) {
    lines.push(`${(data[i]! / 255).toFixed(6)} ${(data[i + 1]! / 255).toFixed(6)} ${(data[i + 2]! / 255).toFixed(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Trilinear lookup of the LUT at an sRGB input (0..1, clamped); returns the 0..1 output colour. */
export function sampleLut(lut: LutData, r: number, g: number, b: number): Rgb {
  const n = lut.size - 1;
  const [or, og, ob] = trilinear(lut.data, lut.size, 4, clamp01(r) * n, clamp01(g) * n, clamp01(b) * n);
  return [or / 255, og / 255, ob / 255];
}

/** Resample a LUT to another lattice size by trilinear interpolation. */
export function resampleLut(lut: LutData, size: number): LutData {
  assertLut(lut);
  return buildLut((r, g, b) => sampleLut(lut, r, g, b), size);
}

function parseTitle(rest: string): string {
  const quoted = /^"([^"]*)"/.exec(rest);
  return (quoted ? quoted[1]! : rest.replace(/#.*$/, '')).trim();
}

function parseSize(tokens: readonly string[], lineNo: number): number {
  if (tokens.length !== 2 || !NUMBER.test(tokens[1]!)) throw lineError(lineNo, 'LUT_3D_SIZE expects one integer');
  const size = Number(tokens[1]);
  if (!Number.isInteger(size) || size < CUBE_MIN_SIZE || size > CUBE_MAX_SIZE) {
    throw lineError(lineNo, `LUT_3D_SIZE must be an integer from ${CUBE_MIN_SIZE} to ${CUBE_MAX_SIZE}, got ${tokens[1]}`);
  }
  return size;
}

/** Three numbers: a table entry, or the values after `keyword`. */
function parseTriple(values: readonly string[], lineNo: number, keyword?: string): Rgb {
  if (values.length !== 3) {
    const expectation = keyword ? `${keyword} expects three numbers` : 'expected three numbers';
    throw lineError(lineNo, `${expectation}, got "${values.join(' ')}"`);
  }
  return [parseNumber(values[0]!, lineNo), parseNumber(values[1]!, lineNo), parseNumber(values[2]!, lineNo)];
}

function parseNumber(token: string, lineNo: number): number {
  if (!NUMBER.test(token)) throw lineError(lineNo, `"${token}" is not a number`);
  const value = Number(token);
  if (!Number.isFinite(value)) throw lineError(lineNo, `"${token}" is out of range`);
  return value;
}

function isUnitDomain(min: Rgb, max: Rgb): boolean {
  return min.every((v) => v === 0) && max.every((v) => v === 1);
}

function quantize(size: number, table: Float64Array): LutData {
  const count = size * size * size;
  const data = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = toByte(table[i * 3]!);
    data[i * 4 + 1] = toByte(table[i * 3 + 1]!);
    data[i * 4 + 2] = toByte(table[i * 3 + 2]!);
    data[i * 4 + 3] = 255;
  }
  return { size, data };
}

/**
 * The file's lattice spans [min, max] per channel; ours spans [0, 1]. Input x
 * sits at file lattice coordinate (x − min) / (max − min) · (N − 1), clamped
 * to the table, where the float table is sampled trilinearly.
 */
function resampleDomain(size: number, table: Float64Array, min: Rgb, max: Rgb): LutData {
  const n = size - 1;
  const coord = (x: number, c: number): number => clamp01((x - min[c]!) / (max[c]! - min[c]!)) * n;
  return buildLut((r, g, b) => trilinear(table, size, 3, coord(r, 0), coord(g, 1), coord(b, 2)), size);
}

/** Trilinear interpolation in a red-fastest lattice; coordinates are in lattice units 0..size−1. */
function trilinear(table: ArrayLike<number>, size: number, stride: number, x: number, y: number, z: number): Rgb {
  const x0 = Math.min(Math.floor(x), size - 2);
  const y0 = Math.min(Math.floor(y), size - 2);
  const z0 = Math.min(Math.floor(z), size - 2);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const dx = stride;
  const dy = size * stride;
  const dz = size * size * stride;
  const base = (z0 * size + y0) * size * stride + x0 * stride;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const i = base + c;
    const c00 = table[i]! + (table[i + dx]! - table[i]!) * fx;
    const c10 = table[i + dy]! + (table[i + dy + dx]! - table[i + dy]!) * fx;
    const c01 = table[i + dz]! + (table[i + dz + dx]! - table[i + dz]!) * fx;
    const c11 = table[i + dz + dy]! + (table[i + dz + dy + dx]! - table[i + dz + dy]!) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    out[c] = c0 + (c1 - c0) * fz;
  }
  return [out[0]!, out[1]!, out[2]!];
}

function assertLut(lut: LutData): void {
  if (!Number.isInteger(lut.size) || lut.size < 2) throw new Error(`Invalid LUT size ${lut.size}`);
  if (lut.data.length !== lut.size ** 3 * 4) {
    throw new Error(`LUT data length ${lut.data.length} does not match size ${lut.size}`);
  }
}

function toByte(v: number): number {
  return Math.round(clamp01(v) * 255);
}
