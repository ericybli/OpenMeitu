import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { MAX_FACES, type Face, type FaceAnalysis, type Point2 } from './types';

export type FaceImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

export interface FaceDetector {
  /** Detect faces in a full-resolution, EXIF-oriented image. Resolves with an empty `faces` array when none are found. */
  detect(image: FaceImageSource): Promise<FaceAnalysis>;
  close(): void;
}

export interface FaceDetectorOptions {
  /** Folder containing the MediaPipe tasks-vision wasm files. Default: `${BASE_URL}mediapipe/wasm`. */
  wasmBaseUrl?: string;
  /** Face Landmarker model. Default: `${BASE_URL}models/face_landmarker.task`. */
  modelUrl?: string;
  /** Most faces returned (the largest win). Clamped to 1..MAX_FACES; default MAX_FACES. */
  maxFaces?: number;
  /** Default: try GPU, fall back to CPU. */
  delegate?: 'GPU' | 'CPU';
}

/**
 * Long edge of the image handed to MediaPipe. Its face detector looks at a
 * 128 x 128 letterboxed copy of whatever it is given, so this resolution
 * does not decide which faces are found (see RELIABLE_FACE and the tiled
 * pass); it bounds the cost of passing the image in and leaves the landmark
 * model enough pixels on small faces.
 */
const DETECT_MAX_EDGE = 1920;

// Tiled second pass. Fractions are of the detection image's long edge and
// face sizes are landmark-box widths (boxes are about 1.3x taller than wide).
/**
 * Faces at least this wide are found reliably by a full-frame pass (single
 * faces down to about 0.1, but in rows of people faces of about 0.1 are
 * often missed).
 */
const RELIABLE_FACE = 0.14;
/** Tile side: half the long edge, so tiles find faces half as wide as a full-frame pass does. */
const TILE_SIZE = 0.5;
/**
 * Least overlap of neighbouring tiles: wider than the box of any face the
 * full-frame pass may miss plus TILE_EDGE_MARGIN on both sides, so each such
 * face lies entirely inside some tile.
 */
const TILE_OVERLAP = 0.25;
/**
 * A tile detection closer than this fraction of its box size to a tile edge
 * inside the image may be cut off, and is dropped: the face is whole in a
 * neighbouring tile.
 */
const TILE_EDGE_MARGIN = 0.1;
/** Below this long edge (px), faces small enough to need tiles are too small to retouch. */
const MIN_TILED_EDGE = 512;

/** A rectangle of the detection image, in pixels. */
interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}

function assetUrl(path: string): string {
  const base = typeof document !== 'undefined' ? document.baseURI : self.location.href;
  return new URL(`${import.meta.env.BASE_URL}${path}`, base).href;
}

function imageSize(image: FaceImageSource): { width: number; height: number } {
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) {
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  return { width: image.width, height: image.height };
}

type Canvas2D = { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D };

function createCanvas(width: number, height: number): Canvas2D | null {
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  return ctx ? { canvas, ctx } : null;
}

/** The image scaled down to at most DETECT_MAX_EDGE on its long edge, with its size. */
function detectionImage(image: FaceImageSource, width: number, height: number): { source: FaceImageSource; width: number; height: number } {
  const s = DETECT_MAX_EDGE / Math.max(width, height);
  if (s >= 1) return { source: image, width, height };
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  const target = createCanvas(w, h);
  if (!target) return { source: image, width, height };
  target.ctx.imageSmoothingQuality = 'high';
  target.ctx.drawImage(image, 0, 0, w, h);
  return { source: target.canvas, width: w, height: h };
}

/** Start offsets of tiles of `size` covering `extent`, neighbours overlapping by at least `overlap`. */
function tileStarts(extent: number, size: number, overlap: number): number[] {
  if (size >= extent) return [0];
  const n = 1 + Math.ceil((extent - size) / (size - overlap));
  return Array.from({ length: n }, (_, i) => Math.round((i * (extent - size)) / (n - 1)));
}

function detectionTiles(width: number, height: number): Tile[] {
  const long = Math.max(width, height);
  const size = Math.round(long * TILE_SIZE);
  const overlap = long * TILE_OVERLAP;
  const tileWidth = Math.min(size, width);
  const tileHeight = Math.min(size, height);
  const xs = tileStarts(width, tileWidth, overlap);
  return tileStarts(height, tileHeight, overlap).flatMap((y) => xs.map((x) => ({ x, y, width: tileWidth, height: tileHeight })));
}

/**
 * Whether tiles could find more faces: they only add faces narrower than
 * about RELIABLE_FACE, so they are skipped for small images and when every
 * face found is at least twice that wide (portraits, close-ups), as anyone
 * missed would then be less than half their size, i.e. in the background.
 */
function worthTiling(faces: readonly Face[], width: number, height: number, maxFaces: number): boolean {
  const long = Math.max(width, height);
  if (long < MIN_TILED_EDGE || faces.length >= maxFaces) return false;
  return faces.length === 0 || faces.some((f) => (f.box.width * width) / long < 2 * RELIABLE_FACE);
}

/**
 * Distance from `face` (normalised to the `width` x `height` detection image)
 * to the nearest edge of `tile` that lies inside the image, relative to the
 * face's box size. Image borders do not count: nothing is cut off there.
 */
function interiorClearance(face: Face, tile: Tile, width: number, height: number): number {
  const x0 = face.box.x * width;
  const y0 = face.box.y * height;
  const x1 = x0 + face.box.width * width;
  const y1 = y0 + face.box.height * height;
  const gaps = [
    tile.x > 0 ? x0 - tile.x : Infinity,
    tile.y > 0 ? y0 - tile.y : Infinity,
    tile.x + tile.width < width ? tile.x + tile.width - x1 : Infinity,
    tile.y + tile.height < height ? tile.y + tile.height - y1 : Infinity,
  ];
  return Math.min(...gaps) / Math.max(x1 - x0, y1 - y0);
}

function contains(box: Face['box'], p: Point2): boolean {
  return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}

function centre(box: Face['box']): Point2 {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Two detections of one face: their boxes overlap substantially or one contains the other's centre. */
function sameFace(a: Face, b: Face): boolean {
  const ix = Math.max(0, Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x));
  const iy = Math.max(0, Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y));
  const inter = ix * iy;
  const union = a.box.width * a.box.height + b.box.width * b.box.height - inter;
  return inter > 0.3 * union || contains(a.box, centre(b.box)) || contains(b.box, centre(a.box));
}

function toFace(points: readonly Point2[]): Face {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const landmarks = points.map((p) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    return { x: p.x, y: p.y };
  });
  return { landmarks, box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}

function area(face: Face): number {
  return face.box.width * face.box.height;
}

/** Let the page paint between detector runs, which block the thread. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * MediaPipe Face Landmarker (Apache-2.0) running locally via WebAssembly.
 * Assets are served from /public (see scripts/setup-assets.mjs); nothing is
 * uploaded anywhere.
 *
 * The detector misses faces narrower than about a tenth of its input's long
 * edge, so group photos get a second pass over overlapping tiles of half
 * the image's size (see `worthTiling`), which finds faces down to about a
 * twentieth of the long edge.
 */
export async function createFaceDetector(options: FaceDetectorOptions = {}): Promise<FaceDetector> {
  const wasmBaseUrl = options.wasmBaseUrl ?? assetUrl('mediapipe/wasm');
  const modelUrl = options.modelUrl ?? assetUrl('models/face_landmarker.task');
  const maxFaces = Math.max(1, Math.min(MAX_FACES, Math.floor(options.maxFaces ?? MAX_FACES)));

  const fileset = await FilesetResolver.forVisionTasks(wasmBaseUrl);
  const make = (delegate: 'GPU' | 'CPU') =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate },
      runningMode: 'IMAGE',
      numFaces: maxFaces,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });

  let landmarker: FaceLandmarker;
  if (options.delegate) {
    landmarker = await make(options.delegate);
  } else {
    try {
      landmarker = await make('GPU');
    } catch {
      landmarker = await make('CPU');
    }
  }

  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error('FaceDetector is closed');
  };
  /** Faces in `source`, which shows `tile` of the detection image `frame`; landmarks are normalised to `frame`. */
  const detectIn = (source: TexImageSource, tile: Tile, frame: { width: number; height: number }): Face[] =>
    (landmarker.detect(source).faceLandmarks ?? [])
      .filter((points) => points.length >= 468)
      .map((points) => toFace(points.map((p) => ({ x: (tile.x + p.x * tile.width) / frame.width, y: (tile.y + p.y * tile.height) / frame.height }))));

  return {
    async detect(image: FaceImageSource): Promise<FaceAnalysis> {
      ensureOpen();
      const { width, height } = imageSize(image);
      const frame = detectionImage(image, width, height);
      const faces: Face[] = [];
      // MediaPipe itself sometimes reports one face twice; the first report wins.
      const add = (face: Face) => {
        if (!faces.some((f) => sameFace(f, face))) faces.push(face);
      };
      detectIn(frame.source, { x: 0, y: 0, width: frame.width, height: frame.height }, frame).forEach(add);

      const tiles = worthTiling(faces, frame.width, frame.height, maxFaces) ? detectionTiles(frame.width, frame.height) : [];
      // Tiles all have the same size.
      const crop = tiles.length > 0 ? createCanvas(tiles[0]!.width, tiles[0]!.height) : null;
      if (crop) {
        const candidates: { face: Face; clearance: number }[] = [];
        for (const tile of tiles) {
          await yieldToEventLoop();
          ensureOpen();
          crop.ctx.clearRect(0, 0, tile.width, tile.height);
          crop.ctx.drawImage(frame.source, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height);
          for (const face of detectIn(crop.canvas, tile, frame)) {
            const clearance = interiorClearance(face, tile, frame.width, frame.height);
            if (clearance >= TILE_EDGE_MARGIN) candidates.push({ face, clearance });
          }
        }
        // Full-frame faces win over tile detections; among tiles, the one most clear of a cut does.
        candidates.sort((a, b) => b.clearance - a.clearance);
        for (const { face } of candidates) add(face);
      }

      // Largest face first: UIs and single-face effects can use faces[0].
      faces.sort((a, b) => area(b) - area(a));
      return { imageWidth: width, imageHeight: height, faces: faces.slice(0, maxFaces) };
    },
    close() {
      if (closed) return;
      closed = true;
      landmarker.close();
    },
  };
}
