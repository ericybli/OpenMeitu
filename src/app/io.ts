import type { PixelResult } from '../engine/renderer';

export type ExportFormat = 'jpeg' | 'png';

export type FileKind = 'image' | 'heic' | 'other';

const IMAGE_EXTENSIONS = /\.(jpe?g|jfif|pjpeg|pjp|png|apng|webp|avif|gif|bmp|ico)$/i;
const HEIC_EXTENSIONS = /\.(heic|heif)$/i;

/** Rough classification before decoding, so obviously wrong files get a clear message. */
export function classifyFile(file: File): FileKind {
  const type = file.type.toLowerCase();
  if (type === 'image/heic' || type === 'image/heif' || HEIC_EXTENSIONS.test(file.name)) return 'heic';
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name)) return 'image';
  return 'other';
}

/** First file in a drop or paste payload (images preferred). */
export function pickFile(files: FileList | readonly File[] | null | undefined): File | null {
  if (!files || files.length === 0) return null;
  const list = Array.from(files);
  return list.find((f) => classifyFile(f) !== 'other') ?? list[0] ?? null;
}

/** File name without directory or extension; falls back to "photo". */
export function baseName(fileName: string | null): string {
  const name = (fileName ?? '').split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();
  return stem || 'photo';
}

/** Strip characters that are invalid in file names on common platforms. */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * Decode an image file upright (EXIF orientation applied) into sRGB with
 * straight alpha, which is what the renderer expects: with the default
 * premultiplied decode, translucent pixels would come out darkened.
 */
export function decodeImage(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  });
}

/** Trigger a download of `blob` and release its object URL afterwards. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start reading the URL asynchronously after click().
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** True when every pixel of the RGBA `data` is fully opaque. */
export function isOpaque(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

/**
 * Straight-alpha RGBA composited onto opaque white. Returns `data` itself when
 * every pixel is already opaque, otherwise a new array.
 */
export function flattenOntoWhite(data: Uint8ClampedArray<ArrayBuffer>): Uint8ClampedArray<ArrayBuffer> {
  if (isOpaque(data)) return data;
  const out = new Uint8ClampedArray(data);
  for (let i = 3; i < out.length; i += 4) {
    const alpha = out[i]!;
    if (alpha === 255) continue;
    const white = 255 * (255 - alpha);
    out[i - 3] = (out[i - 3]! * alpha + white) / 255;
    out[i - 2] = (out[i - 2]! * alpha + white) / 255;
    out[i - 1] = (out[i - 1]! * alpha + white) / 255;
    out[i] = 255;
  }
  return out;
}

/** Encode straight-alpha RGBA pixels as JPEG (quality 0..1, flattened onto white) or PNG (alpha kept). */
export async function encodePixels(pixels: PixelResult, format: ExportFormat, quality: number): Promise<Blob> {
  // Canvas encoders go through premultiplied 8-bit colour, which is exact only for opaque pixels.
  if (format === 'png' && !isOpaque(pixels.data) && typeof CompressionStream === 'function') return encodePng(pixels);
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    // JPEG has no alpha channel; the browser's encoder would composite onto black.
    const data = format === 'jpeg' ? flattenOntoWhite(pixels.data) : pixels.data;
    ctx.putImageData(new ImageData(data, pixels.width, pixels.height), 0, 0);
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('the browser could not encode the image'))),
        mime,
        format === 'jpeg' ? quality : undefined,
      );
    });
  } finally {
    // Release the backing store right away; full-resolution canvases are large.
    canvas.width = 0;
    canvas.height = 0;
  }
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(parts: readonly Uint8Array[]): number {
  let c = 0xffffffff;
  for (const part of parts) for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk as Blob parts, so large chunk data is not copied. */
function pngChunk(type: string, data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32([head.subarray(4), data]));
  return [head, data, crc];
}

/** Encode straight-alpha RGBA pixels as an 8-bit RGBA PNG, exactly. */
export async function encodePng({ width, height, data }: PixelResult): Promise<Blob> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bits per channel
  header[9] = 6; // colour type: RGBA
  const idat = await deflate(paethScanlines(width, height, data));
  const parts = [PNG_SIGNATURE, ...pngChunk('IHDR', header), ...pngChunk('IDAT', idat), ...pngChunk('IEND', new Uint8Array(0))];
  return new Blob(parts, { type: 'image/png' });
}

/** PNG scanlines of RGBA `data`, each with the Paeth filter (type 4), which suits photographs. */
function paethScanlines(width: number, height: number, data: Uint8ClampedArray): Uint8Array<ArrayBuffer> {
  const stride = width * 4;
  const lines = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * stride;
    const out = y * (stride + 1);
    lines[out] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? data[at + x - 4]! : 0;
      const b = y > 0 ? data[at - stride + x]! : 0;
      const c = x >= 4 && y > 0 ? data[at - stride + x - 4]! : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      lines[out + 1 + x] = data[at + x]! - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
  }
  return lines;
}

/** zlib-compress `bytes` with the browser's own deflate. */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const [compressed] = await Promise.all([
    new Response(stream.readable).arrayBuffer(),
    writer.write(bytes).then(() => writer.close()),
  ]);
  return new Uint8Array(compressed);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Resolves once the next frame has been painted (animation frame callbacks run just before painting). */
export function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

export const isApplePlatform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Keyboard shortcut label such as "⌘V" or "Ctrl+V". */
export function shortcutLabel(key: string, shift = false): string {
  if (isApplePlatform) return `${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}
