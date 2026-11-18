import { Renderer } from '../engine/renderer';
import type { AnyLayer } from '../engine/types';
import type { FaceAnalysis } from '../face/types';
import type { LutData } from '../filters/lut';
import { isOpaque } from './io';

/** Thumbnail edge in pixels (tiles are shown at ~72 CSS px, so this covers 2x displays). */
export const THUMBNAIL_SIZE = 144;

/**
 * Renders small square previews (filter looks, presets) with its own
 * Renderer on a detached canvas, so the main preview is never disturbed.
 */
export class ThumbnailRenderer {
  private readonly renderer: Renderer;
  private readonly encoder: HTMLCanvasElement;
  private readonly encoderContext: CanvasRenderingContext2D;

  constructor() {
    this.renderer = new Renderer(document.createElement('canvas'));
    this.encoder = document.createElement('canvas');
    this.encoder.width = THUMBNAIL_SIZE;
    this.encoder.height = THUMBNAIL_SIZE;
    const ctx = this.encoder.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.encoderContext = ctx;
  }

  /** Use a square crop of `image`, centred on the main face when there is one. */
  setImage(image: ImageBitmap, face: FaceAnalysis | null): void {
    const side = Math.min(image.width, image.height);
    const box = face?.faces[0]?.box;
    const focusX = box ? box.x + box.width / 2 : 0.5;
    // Without a face, bias portrait crops upwards where heads usually are.
    const focusY = box ? box.y + box.height / 2 : image.height > image.width ? 0.4 : 0.5;
    const sx = clamp(focusX * image.width - side / 2, 0, image.width - side);
    const sy = clamp(focusY * image.height - side / 2, 0, image.height - side);

    const crop = document.createElement('canvas');
    crop.width = THUMBNAIL_SIZE;
    crop.height = THUMBNAIL_SIZE;
    const ctx = crop.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, sx, sy, side, side, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    this.renderer.setSource(crop);
    this.renderer.setAnalysis(null);
  }

  registerLut(id: string, lut: LutData): void {
    this.renderer.registerCustomLut(id, lut);
  }

  /** Render `layers` and return a data URL: JPEG, or PNG when the photo has transparency to show. */
  render(layers: readonly AnyLayer[]): string {
    const px = this.renderer.renderToPixels(layers);
    this.encoderContext.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
    return isOpaque(px.data) ? this.encoder.toDataURL('image/jpeg', 0.86) : this.encoder.toDataURL('image/png');
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
