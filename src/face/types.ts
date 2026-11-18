/** Normalised point: x right, y down, both 0..1 relative to the source image. */
export interface Point2 {
  x: number;
  y: number;
}

export interface Face {
  /**
   * 478 MediaPipe Face Mesh landmarks (468 mesh + 10 iris), normalised.
   * Index semantics follow the MediaPipe canonical face model.
   */
  landmarks: Point2[];
  /** Normalised bounding box of the landmarks. */
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Most faces an analysis holds (the largest win). Every face gets every
 * retouch: the skin and teeth masks cover all of them, and the face-reshape
 * shader's uniform arrays are sized for this many (see warp.ts).
 */
export const MAX_FACES = 8;

export interface FaceAnalysis {
  /** Pixel size of the image that was analysed (the full-resolution source). */
  imageWidth: number;
  imageHeight: number;
  faces: Face[];
}
