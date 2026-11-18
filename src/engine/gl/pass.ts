import type { FaceAnalysis } from '../../face/types';
import type { Layer, LayerKind } from '../types';
import type { Gpu, GpuTexture, RenderTarget } from './gpu';

/**
 * Per-render cache for derived GPU resources (masks, blurred copies, ...).
 * The renderer clears it whenever the source image, face analysis, crop or
 * working resolution changes, calling each entry's `dispose`. Include
 * anything else the value depends on (e.g. parameters) in the key.
 */
export interface PassCache {
  get<T>(key: string, create: () => T, dispose?: (value: T) => void): T;
}

/** Resolves a filter look id (built-in or `custom:<id>`) to a 3D LUT texture. */
export interface LutProvider {
  getLut(lookId: string): GpuTexture | null;
}

export interface PassEnv {
  gpu: Gpu;
  /**
   * Pixel size of the working image entering this pass. The renderer crops
   * first, so this is the final frame (the crop, still unrotated), not
   * necessarily the whole photo.
   */
  width: number;
  height: number;
  /**
   * Working pixels per source pixel (1 for full-resolution export, < 1 for
   * preview). Effects MUST look the same at any scale: express radii relative
   * to image size or face size, never as fixed pixel counts.
   */
  scale: number;
  /**
   * Diagonal of the whole photo in source pixels, crop or not. Sizes that
   * belong to the photo rather than to the frame (e.g. film grain) use it.
   */
  sourceDiagonal: number;
  /**
   * Face analysis in normalised coordinates of the working frame (x right,
   * y down), which equal uv coordinates for every stage before `transform`.
   * Points outside the crop lie outside 0..1. Null when detection has not
   * run or found nothing.
   */
  face: FaceAnalysis | null;
  cache: PassCache;
  luts: LutProvider;
}

export interface Pass<K extends LayerKind> {
  readonly kind: K;
  /** Output size; defaults to the input size. Only `transform` changes it. */
  outputSize?(env: PassEnv, layer: Layer<K>): { width: number; height: number };
  /**
   * Render `layer` applied to `input` into `output`. Do NOT apply
   * `layer.opacity` or check `layer.enabled` — the renderer does both.
   * Must not write to `input`. Release any pooled targets you acquire.
   */
  run(env: PassEnv, input: GpuTexture, output: RenderTarget, layer: Layer<K>): void;
}
