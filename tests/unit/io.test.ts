import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng, flattenOntoWhite, isOpaque } from '../../src/app/io';

describe('isOpaque', () => {
  it('is true only when every pixel has full alpha', () => {
    expect(isOpaque(new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 255]))).toBe(true);
    expect(isOpaque(new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 254]))).toBe(false);
  });
});

describe('flattenOntoWhite', () => {
  it('returns opaque pixels untouched, without copying', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255, 200, 100, 0, 255]);
    expect(flattenOntoWhite(data)).toBe(data);
  });

  it('composites straight-alpha pixels onto white without changing the input', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255, 200, 120, 40, 128, 0, 0, 0, 0, 255, 0, 0, 1]);
    const input = data.slice();
    expect([...flattenOntoWhite(data)]).toEqual([10, 20, 30, 255, 227, 187, 147, 255, 255, 255, 255, 255, 255, 254, 254, 255]);
    expect(data).toEqual(input);
  });
});

describe('encodePng', () => {
  /** Straight-alpha RGBA PNG decoder for what encodePng writes (8-bit RGBA, any filter). */
  function decode(png: Buffer): { width: number; height: number; data: Uint8Array } {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: { type: string; data: Buffer }[] = [];
    for (let i = 8; i < png.length; ) {
      const length = png.readUInt32BE(i);
      const type = png.toString('latin1', i + 4, i + 8);
      const data = png.subarray(i + 8, i + 8 + length);
      expect(png.readUInt32BE(i + 8 + length)).toBe(crc32(png.subarray(i + 4, i + 8 + length)));
      chunks.push({ type, data });
      i += 12 + length;
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const header = chunks[0]!.data;
    const width = header.readUInt32BE(0);
    const height = header.readUInt32BE(4);
    expect([...header.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    const rows = inflateSync(chunks[1]!.data);
    const stride = width * 4;
    const data = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
      const filter = rows[y * (stride + 1)]!;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? data[y * stride + x - 4]! : 0;
        const b = y > 0 ? data[(y - 1) * stride + x]! : 0;
        const c = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4]! : 0;
        const p = a + b - c;
        const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        data[y * stride + x] = (rows[y * (stride + 1) + 1 + x]! + [0, a, b, (a + b) >> 1, paeth][filter]!) & 0xff;
      }
    }
    return { width, height, data };
  }

  it('keeps every channel of translucent pixels exactly', async () => {
    const width = 37;
    const height = 11;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24; // varied bytes, alpha included
    const blob = await encodePng({ width, height, data });
    expect(blob.type).toBe('image/png');
    const decoded = decode(Buffer.from(await blob.arrayBuffer()));
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    expect([...decoded.data]).toEqual([...data]);
  });
});
