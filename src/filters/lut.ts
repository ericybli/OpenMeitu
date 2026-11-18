/**
 * 3D colour lookup tables.
 *
 * Layout: RGBA8, `size^3 * 4` bytes, red varies fastest:
 *   index = ((b * size + g) * size + r) * 4
 * Entry (r, g, b) holds the output colour for input
 * (r/(size-1), g/(size-1), b/(size-1)). Alpha is always 255.
 */
export interface LutData {
  size: number;
  data: Uint8Array;
}

export const DEFAULT_LUT_SIZE = 33;

export type ColorFn = (r: number, g: number, b: number) => readonly [number, number, number];

/** Build a LUT by evaluating `fn` (0..1 in, 0..1 out; values are clamped) at every lattice point. */
export function buildLut(fn: ColorFn, size: number = DEFAULT_LUT_SIZE): LutData {
  if (!Number.isInteger(size) || size < 2 || size > 128) throw new Error(`Invalid LUT size ${size}`);
  const data = new Uint8Array(size * size * size * 4);
  const inv = 1 / (size - 1);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const [or, og, ob] = fn(r * inv, g * inv, b * inv);
        data[i++] = toByte(or);
        data[i++] = toByte(og);
        data[i++] = toByte(ob);
        data[i++] = 255;
      }
    }
  }
  return { size, data };
}

export function identityLut(size: number = DEFAULT_LUT_SIZE): LutData {
  return buildLut((r, g, b) => [r, g, b], size);
}

function toByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}
