import type { CropRect } from '../engine/types';

/**
 * Crop geometry in "display space": normalised 0..1 coordinates of the image
 * after rotate + flip, which is exactly the space `TransformParams.crop` uses.
 */

export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

export const CROP_ASPECTS = ['free', 'original', '1:1', '4:5', '3:4', '9:16', '16:9'] as const;
export type CropAspect = (typeof CROP_ASPECTS)[number];

/** Each side of the crop frame stays at least this fraction of the image. */
const MIN_CROP = 0.05;
/** Rectangles closer than this to the full image are treated as "no crop". */
const FULL_EPSILON = 1e-4;

export const FULL_RECT: CropRect = { x: 0, y: 0, width: 1, height: 1 };

export interface Size {
  width: number;
  height: number;
}

/** Pixel aspect ratio (width / height) of a preset, or null for free-form. */
export function aspectRatioOf(aspect: CropAspect, image: Size): number | null {
  switch (aspect) {
    case 'free':
      return null;
    case 'original':
      return image.width / image.height;
    default: {
      const [w, h] = aspect.split(':').map(Number) as [number, number];
      return w / h;
    }
  }
}

/** Converts a pixel aspect ratio into the ratio of normalised width / height. */
export function normalizedRatio(pixelRatio: number, image: Size): number {
  return (pixelRatio * image.height) / image.width;
}

/** Largest rectangle with normalised ratio `ratio`, centred in the image. */
export function centeredRect(ratio: number): CropRect {
  let width = 1;
  let height = 1 / ratio;
  if (height > 1) {
    height = 1;
    width = ratio;
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

export function isFullRect(rect: CropRect): boolean {
  return (
    Math.abs(rect.x) < FULL_EPSILON &&
    Math.abs(rect.y) < FULL_EPSILON &&
    Math.abs(rect.width - 1) < FULL_EPSILON &&
    Math.abs(rect.height - 1) < FULL_EPSILON
  );
}

/** Clamp into the unit square; a full-image rectangle becomes `null` (no crop). */
export function normalizeCrop(rect: CropRect | null): CropRect | null {
  if (!rect) return null;
  const x = clamp(rect.x, 0, 1 - MIN_CROP);
  const y = clamp(rect.y, 0, 1 - MIN_CROP);
  const out = {
    x,
    y,
    width: clamp(rect.width, MIN_CROP, 1 - x),
    height: clamp(rect.height, MIN_CROP, 1 - y),
  };
  return isFullRect(out) ? null : out;
}

/** The crop rectangle after rotating the displayed image 90° clockwise. */
export function rotateRectCW(r: CropRect): CropRect {
  return { x: 1 - r.y - r.height, y: r.x, width: r.height, height: r.width };
}

/** The crop rectangle after rotating the displayed image 90° counter-clockwise. */
export function rotateRectCCW(r: CropRect): CropRect {
  return { x: r.y, y: 1 - r.x - r.width, width: r.height, height: r.width };
}

export function flipRectH(r: CropRect): CropRect {
  return { ...r, x: 1 - r.x - r.width };
}

export function flipRectV(r: CropRect): CropRect {
  return { ...r, y: 1 - r.y - r.height };
}

/**
 * New crop rectangle after dragging `handle` by (dx, dy) normalised units
 * from `start`. With a `ratio` (normalised width / height) the frame keeps
 * its aspect: corners scale about the opposite corner, edges about the
 * centre of the opposite edge.
 */
export function dragCrop(start: CropRect, handle: CropHandle, dx: number, dy: number, ratio: number | null): CropRect {
  if (handle === 'move') {
    return {
      ...start,
      x: clamp(start.x + dx, 0, 1 - start.width),
      y: clamp(start.y + dy, 0, 1 - start.height),
    };
  }
  return ratio === null ? dragFree(start, handle, dx, dy) : dragLocked(start, handle, dx, dy, ratio);
}

function dragFree(start: CropRect, handle: Exclude<CropHandle, 'move'>, dx: number, dy: number): CropRect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP);
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_CROP, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function dragLocked(start: CropRect, handle: Exclude<CropHandle, 'move'>, dx: number, dy: number, ratio: number): CropRect {
  const minWidth = Math.max(MIN_CROP, MIN_CROP * ratio);
  const right = start.x + start.width;
  const bottom = start.y + start.height;

  if (handle.length === 2) {
    const east = handle.includes('e');
    const south = handle.includes('s');
    const anchorX = east ? start.x : right;
    const anchorY = south ? start.y : bottom;
    const proposedW = start.width + (east ? dx : -dx);
    const proposedH = start.height + (south ? dy : -dy);
    const maxW = Math.min(east ? 1 - anchorX : anchorX, (south ? 1 - anchorY : anchorY) * ratio);
    const width = clamp(Math.max(proposedW, proposedH * ratio), Math.min(minWidth, maxW), maxW);
    const height = width / ratio;
    return { x: east ? anchorX : anchorX - width, y: south ? anchorY : anchorY - height, width, height };
  }

  if (handle === 'e' || handle === 'w') {
    const east = handle === 'e';
    const anchorX = east ? start.x : right;
    const centerY = start.y + start.height / 2;
    const maxW = Math.min(east ? 1 - anchorX : anchorX, 2 * Math.min(centerY, 1 - centerY) * ratio);
    const width = clamp(start.width + (east ? dx : -dx), Math.min(minWidth, maxW), maxW);
    const height = width / ratio;
    return { x: east ? anchorX : anchorX - width, y: centerY - height / 2, width, height };
  }

  const south = handle === 's';
  const anchorY = south ? start.y : bottom;
  const centerX = start.x + start.width / 2;
  const maxH = Math.min(south ? 1 - anchorY : anchorY, (2 * Math.min(centerX, 1 - centerX)) / ratio);
  const height = clamp(start.height + (south ? dy : -dy), Math.min(minWidth / ratio, maxH), maxH);
  const width = height * ratio;
  return { x: centerX - width / 2, y: south ? anchorY : anchorY - height, width, height };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
