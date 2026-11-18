/**
 * Browser-side test harness for Playwright (served at /harness.html in dev).
 * Exposes `window.omHarness` so tests can run the real GPU engine on
 * synthetic or fixture images and read pixels back.
 */
import { gaussianBlur } from '../engine/gl/blur';
import type { GpuOptions } from '../engine/gl/gpu';
import { Renderer } from '../engine/renderer';
import type { AnyLayer } from '../engine/types';
import { createFaceDetector, type FaceDetector } from '../face/detector';
import type { FaceAnalysis } from '../face/types';

export type HarnessImage = ({ width: number; height: number; data: number[] } | { url: string }) & {
  /** Resample to this size (nearest neighbour) after decoding: large test images without large transfers. */
  resize?: { width: number; height: number };
};

export interface HarnessRenderRequest {
  image: HarnessImage;
  layers: AnyLayer[];
  analysis?: FaceAnalysis | null;
  maxSize?: number;
  /** Lower the GPU texture size limit, to test sources that do not fit it. */
  maxTextureSize?: number;
  /** Imported LUTs, referenced by layers as `custom:<id>`. */
  customLuts?: Record<string, { size: number; data: number[] }>;
  /** 'array' (default) returns number[]; 'base64' returns a base64 string of RGBA bytes. */
  encoding?: 'array' | 'base64';
}

/** One draw call: the program and the size of the target it filled (the canvas for presents). */
export interface HarnessDraw {
  program: string;
  width: number;
  height: number;
}

export interface HarnessRenderResult {
  width: number;
  height: number;
  data?: number[];
  base64?: string;
}

async function loadImage(image: HarnessImage): Promise<ImageBitmap> {
  const opts: ImageBitmapOptions = {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
    imageOrientation: 'from-image',
    ...(image.resize ? { resizeWidth: image.resize.width, resizeHeight: image.resize.height, resizeQuality: 'pixelated' } : {}),
  };
  if ('url' in image) {
    const res = await fetch(image.url);
    if (!res.ok) throw new Error(`fetch ${image.url}: HTTP ${res.status}`);
    return createImageBitmap(await res.blob(), opts);
  }
  const imageData = new ImageData(Uint8ClampedArray.from(image.data), image.width, image.height);
  return createImageBitmap(imageData, opts);
}

function toBase64(bytes: Uint8ClampedArray): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

let detector: Promise<FaceDetector> | null = null;

const harness = {
  ready: true,

  info() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    return {
      webgl2: !!gl,
      renderer: gl ? String(gl.getParameter(gl.RENDERER)) : null,
      maxTextureSize: gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 0,
    };
  },

  async render(req: HarnessRenderRequest): Promise<HarnessRenderResult> {
    const bitmap = await loadImage(req.image);
    const renderer = harness.createRenderer({ maxTextureSize: req.maxTextureSize });
    try {
      renderer.setSource(bitmap);
      renderer.setAnalysis(req.analysis ?? null);
      for (const [id, lut] of Object.entries(req.customLuts ?? {})) {
        renderer.registerCustomLut(id, { size: lut.size, data: Uint8Array.from(lut.data) });
      }
      const out = renderer.renderToPixels(req.layers, { maxSize: req.maxSize });
      return req.encoding === 'base64'
        ? { width: out.width, height: out.height, base64: toBase64(out.data) }
        : { width: out.width, height: out.height, data: Array.from(out.data) };
    } finally {
      renderer.dispose();
      bitmap.close();
    }
  },

  /** Decode a test image as `render` does. */
  loadImage,

  /** A Renderer on a detached canvas, for tests that drive it directly. Dispose it when done. */
  createRenderer(options?: GpuOptions): Renderer {
    return new Renderer(document.createElement('canvas'), options);
  },

  gaussianBlur,

  /** Log every draw `renderer` makes from now on. Empty the returned array to start a new log. */
  traceDraws(renderer: Renderer): HarnessDraw[] {
    const log: HarnessDraw[] = [];
    const gpu = renderer.gpu;
    const draw = gpu.draw.bind(gpu);
    gpu.draw = (program, target, ...rest) => {
      log.push({ program: program.key, width: target?.width ?? gpu.gl.drawingBufferWidth, height: target?.height ?? gpu.gl.drawingBufferHeight });
      draw(program, target, ...rest);
    };
    return log;
  },

  /** Track the 2D textures `renderer` creates from now on; the result reports the bytes of those still alive. */
  traceTextures(renderer: Renderer): () => number {
    const gpu = renderer.gpu;
    const live = new Map<WebGLTexture, number>();
    const create = gpu.createTexture.bind(gpu);
    const remove = gpu.deleteTexture.bind(gpu);
    gpu.createTexture = (width, height, ...rest) => {
      const tex = create(width, height, ...rest);
      live.set(tex.texture, width * height * 4);
      return tex;
    };
    gpu.deleteTexture = (tex) => {
      live.delete(tex.texture);
      remove(tex);
    };
    return () => [...live.values()].reduce((sum, bytes) => sum + bytes, 0);
  },

  /** The pixels on `renderer`'s canvas (RGBA, bottom row first). */
  readCanvas(renderer: Renderer): Uint8Array {
    const gl = renderer.gpu.gl;
    const out = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  },

  async detectFaces(url: string): Promise<FaceAnalysis> {
    detector ??= createFaceDetector();
    const d = await detector;
    const bitmap = await loadImage({ url });
    try {
      return await d.detect(bitmap);
    } finally {
      bitmap.close();
    }
  },
};

declare global {
  interface Window {
    omHarness: typeof harness;
  }
}

window.omHarness = harness;
