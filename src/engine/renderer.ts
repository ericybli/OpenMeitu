import type { FaceAnalysis, Point2 } from '../face/types';
import { getLook } from '../filters/looks';
import type { LutData } from '../filters/lut';
import { Gpu, sourceSize, type GpuOptions, type GpuTexture, type RenderTarget } from './gl/gpu';
import { GLSL_HEADER } from './gl/glsl';
import type { LutProvider, Pass, PassCache, PassEnv } from './gl/pass';
import { PASSES } from './gl/passes';
import { cropRegion, type PixelRect } from './gl/passes/transform';
import { FACE_DEPENDENT_KINDS, isIdentityLayer, stageIndex, type AnyLayer, type Layer, type LayerKind } from './types';

/** Fades a layer: input and output are the same size, so texels are read exactly. */
const MIX_SHADER = `${GLSL_HEADER}
uniform sampler2D u_base;
uniform sampler2D u_effect;
uniform float u_opacity;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = mix(texelFetch(u_base, p, 0), texelFetch(u_effect, p, 0), u_opacity);
}
`;

/** Resamples the part `u_region` (x, y, width, height in uv) of an image to the whole target. */
const REGION_SHADER = `${GLSL_HEADER}
uniform sampler2D u_image;
uniform vec4 u_region;
void main() {
  outColor = texture(u_image, u_region.xy + v_uv * u_region.zw);
}
`;

/** Copies texels exactly, starting at `u_offset`. */
const TEXEL_COPY_SHADER = `${GLSL_HEADER}
uniform sampler2D u_image;
uniform ivec2 u_offset;
void main() {
  // Render-target row 0 is the image top, so gl_FragCoord is the output pixel (x right, y down).
  outColor = texelFetch(u_image, ivec2(gl_FragCoord.xy) + u_offset, 0);
}
`;

export interface PixelResult {
  width: number;
  height: number;
  /** RGBA8, row 0 = top (ImageData order). */
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface PreviewOptions {
  /** Canvas drawing-buffer size in device pixels. */
  width: number;
  height: number;
  /** Show the unedited image (keeping crop/rotate so the framing matches). */
  showOriginal?: boolean;
}

interface CacheEntry {
  value: unknown;
  dispose?: (value: unknown) => void;
}

/** What `run` renders: a region of the source and the layers to apply to it. */
interface Frame {
  /** Source texels the output shows: the crop, before rotate and flip. */
  region: PixelRect;
  /** Active layers, with the crop taken out of the transform layer. */
  layers: AnyLayer[];
}

interface RunResult {
  tex: GpuTexture;
  /** The caller must release `tex` (a pooled target) when done. */
  owned: boolean;
}

/**
 * Runs a layer stack on the GPU.
 *
 * The crop is applied first: the stack runs on the cropped region only, so
 * effects see the final frame (a vignette is centred on the crop) and cost
 * follows the output size. Rotate and flip are applied last.
 *
 * Usage:
 *   const r = new Renderer(canvas);
 *   r.setSource(bitmap);            // full-resolution, EXIF-oriented image
 *   r.setAnalysis(faces);           // optional, any time
 *   const size = r.measureOutput(layers);   // full-res output size (after crop/rotate)
 *   r.renderPreview(layers, { width, height });  // draw to the canvas
 *   const px = r.renderToPixels(layers);         // full-res export
 */
export class Renderer {
  readonly gpu: Gpu;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;

  private source: GpuTexture | null = null;
  private sourceVersion = 0;
  private originalSize = { width: 0, height: 0 };
  private working: { key: string; tex: RenderTarget } | null = null;

  private analysis: FaceAnalysis | null = null;
  private analysisVersion = 0;

  private readonly cacheEntries = new Map<string, CacheEntry>();
  private cacheToken = '';

  /**
   * The texture entering one layer of a previewed stack, keyed by everything
   * it depends on (see `stackKeys`). While a slider is dragged, rendering
   * restarts from here instead of re-running the unchanged layers before it.
   */
  private prefix: { key: string; tex: RenderTarget } | null = null;
  private lastPreviewKeys: readonly string[] = [];

  private readonly lutTextures = new Map<string, GpuTexture>();
  private readonly customLuts = new Map<string, LutData>();

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options?: GpuOptions) {
    this.canvas = canvas;
    this.gpu = Gpu.create(canvas, options);
  }

  /** Pixel size of the source as given (before any GPU-size clamping). */
  get sourceSize(): { width: number; height: number } {
    return { ...this.originalSize };
  }

  get hasSource(): boolean {
    return this.source !== null;
  }

  /**
   * Set the full-resolution source image. Pass an already EXIF-oriented
   * source (e.g. `createImageBitmap(file, { imageOrientation: 'from-image' })`).
   * Images larger than the GPU's max texture size are downscaled.
   */
  setSource(source: TexImageSource): void {
    const size = sourceSize(source);
    const max = this.gpu.maxTextureSize;
    let upload: TexImageSource = source;
    if (size.width > max || size.height > max) {
      const s = max / Math.max(size.width, size.height);
      upload = drawScaled(source, Math.max(1, Math.floor(size.width * s)), Math.max(1, Math.floor(size.height * s)));
    }
    // Upload first: if it throws, the renderer keeps its current source untouched.
    const tex = this.gpu.uploadImage(upload);
    if (this.source) this.gpu.deleteTexture(this.source);
    this.source = tex;
    this.originalSize = { ...size };
    this.sourceVersion++;
    this.dropWorking();
    this.clearCache();
    this.dropPrefix();
    this.gpu.trimPool();
  }

  setAnalysis(analysis: FaceAnalysis | null): void {
    this.analysis = analysis;
    this.analysisVersion++;
    this.clearCache();
    this.dropPrefix();
  }

  /** Register an imported LUT; reference it from a filter layer as `custom:<id>`. */
  registerCustomLut(id: string, lut: LutData): void {
    const key = `custom:${id}`;
    this.customLuts.set(key, lut);
    const old = this.lutTextures.get(key);
    if (old) {
      this.gpu.deleteTexture(old);
      this.lutTextures.delete(key);
    }
    this.dropPrefix();
  }

  /** Full-resolution output size for this layer stack (accounts for crop/rotate). */
  measureOutput(layers: readonly AnyLayer[]): { width: number; height: number } {
    const src = this.requireSource();
    let size = { width: src.width, height: src.height };
    for (const layer of this.activeLayers(layers, false)) {
      const pass = PASSES[layer.kind] as Pass<LayerKind>;
      if (pass.outputSize) size = pass.outputSize(this.makeEnv(size.width, size.height, 1, null), layer as Layer<LayerKind>);
    }
    return size;
  }

  /** Render to the canvas at roughly `width x height` device pixels. */
  renderPreview(layers: readonly AnyLayer[], opts: PreviewOptions): { width: number; height: number } {
    const width = Math.max(1, Math.round(opts.width));
    const height = Math.max(1, Math.round(opts.height));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const full = this.measureOutput(layers);
    const scale = Math.min(1, Math.max(width / full.width, height / full.height));
    const result = this.run(layers, scale, Boolean(opts.showOriginal), true);
    this.gpu.present(result.tex);
    const out = { width: result.tex.width, height: result.tex.height };
    if (result.owned) this.gpu.release(result.tex as RenderTarget);
    return out;
  }

  /** Render at full resolution (or limited to `maxSize` on the long edge) and read back. */
  renderToPixels(layers: readonly AnyLayer[], opts: { maxSize?: number } = {}): PixelResult {
    const full = this.measureOutput(layers);
    const longEdge = Math.max(full.width, full.height);
    const scale = opts.maxSize && longEdge > opts.maxSize ? opts.maxSize / longEdge : 1;
    const frameBefore = this.cacheToken;
    const workingBefore = this.working;
    try {
      const result = this.run(layers, scale, false, false);
      let target: RenderTarget;
      if (result.owned) {
        target = result.tex as RenderTarget;
      } else {
        target = this.gpu.acquire(result.tex.width, result.tex.height);
        this.gpu.copy(result.tex, target);
      }
      const data = this.gpu.readPixels(target);
      this.gpu.release(target);
      return { width: target.width, height: target.height, data };
    } finally {
      // Do not keep what was built for this frame (e.g. full-resolution temporaries of an export).
      // An export of the whole photo reads the source directly and leaves the preview's working image.
      if (this.cacheToken !== frameBefore) this.clearCache();
      if (this.working !== workingBefore) this.dropWorking();
      this.gpu.trimPool();
    }
  }

  dispose(): void {
    this.clearCache();
    this.dropWorking();
    this.dropPrefix();
    for (const t of this.lutTextures.values()) this.gpu.deleteTexture(t);
    this.lutTextures.clear();
    if (this.source) this.gpu.deleteTexture(this.source);
    this.source = null;
    this.gpu.dispose();
  }

  // ------------------------------------------------------------------ internals

  private requireSource(): GpuTexture {
    if (!this.source) throw new Error('Renderer: no source image set');
    return this.source;
  }

  private activeLayers(layers: readonly AnyLayer[], originalOnly: boolean): AnyLayer[] {
    const hasFace = !!this.analysis && this.analysis.faces.length > 0;
    return layers
      .filter((l) => (originalOnly ? l.kind === 'transform' : true))
      .filter((l) => !isIdentityLayer(l) || (l.kind === 'transform' && l.enabled && !isIdentityLayer({ ...l, opacity: 1 })))
      .filter((l) => hasFace || !FACE_DEPENDENT_KINDS.includes(l.kind))
      .slice()
      .sort((a, b) => stageIndex(a.kind) - stageIndex(b.kind));
  }

  /** The region of the source that the output shows, and the layers to render on it. */
  private frame(layers: readonly AnyLayer[], originalOnly: boolean): Frame {
    const src = this.requireSource();
    const active = this.activeLayers(layers, originalOnly);
    const transform = active.find((l): l is Layer<'transform'> => l.kind === 'transform');
    if (!transform?.params.crop) return { region: { x: 0, y: 0, width: src.width, height: src.height }, layers: active };
    const { rotate, flipH, flipV } = transform.params;
    const uncropped: Layer<'transform'> = { ...transform, params: { ...transform.params, crop: null } };
    const reorients = rotate !== 0 || flipH || flipV;
    return {
      region: cropRegion(src, transform.params),
      layers: active.flatMap((l) => (l !== transform ? [l] : reorients ? [uncropped] : [])),
    };
  }

  /**
   * `region` of the source resampled to `width` x `height` (cached), or the
   * source itself when that is all of it at full size.
   */
  private workingSource(region: PixelRect, width: number, height: number): GpuTexture {
    const src = this.requireSource();
    const exact = width === region.width && height === region.height;
    if (exact && width === src.width && height === src.height) return src;
    const key = `${this.sourceVersion}:${rectKey(region)}:${width}x${height}`;
    if (this.working?.key === key) return this.working.tex;
    this.dropWorking();
    const tex = this.gpu.createTarget(width, height);
    if (exact) {
      this.gpu.draw(this.gpu.program('renderer.texelCopy', TEXEL_COPY_SHADER), tex, { u_image: src, u_offset: [region.x, region.y] });
    } else {
      // Successive halving avoids aliasing for large reductions. Only the region is read.
      let cur: GpuTexture = src;
      let area = region;
      const temps: RenderTarget[] = [];
      while (area.width / 2 >= width && area.height / 2 >= height) {
        const t = this.gpu.createTarget(Math.max(width, Math.floor(area.width / 2)), Math.max(height, Math.floor(area.height / 2)));
        this.resample(cur, area, t);
        temps.push(t);
        cur = t;
        area = { x: 0, y: 0, width: t.width, height: t.height };
      }
      this.resample(cur, area, tex);
      for (const t of temps) this.gpu.deleteTexture(t);
    }
    this.working = { key, tex };
    return tex;
  }

  private resample(input: GpuTexture, area: PixelRect, output: RenderTarget): void {
    this.gpu.draw(this.gpu.program('renderer.region', REGION_SHADER), output, {
      u_image: input,
      u_region: [area.x / input.width, area.y / input.height, area.width / input.width, area.height / input.height],
    });
  }

  private dropWorking(): void {
    if (this.working) this.gpu.deleteTexture(this.working.tex);
    this.working = null;
  }

  /** The face analysis in the normalised coordinates of `region`. */
  private frameAnalysis(region: PixelRect): FaceAnalysis | null {
    const analysis = this.analysis;
    if (!analysis || analysis.faces.length === 0) return null;
    const src = this.requireSource();
    if (region.width === src.width && region.height === src.height) return analysis;
    // Cached with the frame: the pass cache is cleared whenever the region or analysis changes.
    return this.passCache.get('renderer.frameAnalysis', () =>
      cropAnalysis(analysis, {
        x: region.x / src.width,
        y: region.y / src.height,
        width: region.width / src.width,
        height: region.height / src.height,
      }),
    );
  }

  /** Render `layers` with the crop's region scaled by `scale` (texture pixels, at most 1). */
  private run(layers: readonly AnyLayer[], scale: number, originalOnly: boolean, isPreview: boolean): RunResult {
    const src = this.requireSource();
    const { region, layers: stack } = this.frame(layers, originalOnly);
    const s = Math.min(1, scale);
    const width = Math.max(1, Math.round(region.width * s));
    const height = Math.max(1, Math.round(region.height * s));

    const frameKey = `${this.sourceVersion}:${this.analysisVersion}:${rectKey(region)}:${width}x${height}`;
    if (frameKey !== this.cacheToken) {
      this.clearCache();
      this.cacheToken = frameKey;
    }
    const input = this.workingSource(region, width, height);
    // Passes measure in original pixels; the source texture may have been downscaled to fit the GPU.
    const envScale = (width / region.width) * (src.width / Math.max(1, this.originalSize.width));
    const face = this.frameAnalysis(region);

    const keys = stackKeys(frameKey, stack);
    let start = 0;
    let cur: GpuTexture = input;
    const cachedAt = this.prefix ? keys.indexOf(this.prefix.key) : -1;
    if (this.prefix && cachedAt >= 0) {
      start = cachedAt;
      cur = this.prefix.tex;
    }
    // Keep the texture entering the first layer that changed since the last preview.
    let keepAt = -1;
    if (isPreview) {
      keepAt = leadingMatches(keys, this.lastPreviewKeys) - 1;
      this.lastPreviewKeys = keys;
    }

    let owned = false;
    for (let i = start; ; i++) {
      if (i === keepAt && i > start) {
        this.keepPrefix(keys[i]!, cur as RenderTarget);
        owned = false;
      }
      const layer = stack[i];
      if (!layer) break;
      const pass = PASSES[layer.kind] as Pass<LayerKind>;
      const env = this.makeEnv(cur.width, cur.height, envScale, face);
      const typed = (layer.kind === 'faceReshape' ? fadedWarp(layer) : layer) as Layer<LayerKind>;
      const size = pass.outputSize ? pass.outputSize(env, typed) : { width: cur.width, height: cur.height };
      let out = this.gpu.acquire(size.width, size.height);
      pass.run(env, cur, out, typed);
      const blendable = typed.kind !== 'transform' && size.width === cur.width && size.height === cur.height;
      if (blendable && typed.opacity < 1) {
        const mixed = this.gpu.acquire(size.width, size.height);
        this.gpu.draw(this.gpu.program('renderer.mix', MIX_SHADER), mixed, {
          u_base: cur,
          u_effect: out,
          u_opacity: Math.max(0, typed.opacity),
        });
        this.gpu.release(out);
        out = mixed;
      }
      if (owned) this.gpu.release(cur as RenderTarget);
      cur = out;
      owned = true;
    }
    return { tex: cur, owned };
  }

  /** Make `tex` (owned by the caller until now) the cached prefix texture. */
  private keepPrefix(key: string, tex: RenderTarget): void {
    if (this.prefix) this.gpu.release(this.prefix.tex);
    this.prefix = { key, tex };
  }

  private dropPrefix(): void {
    if (this.prefix) this.gpu.release(this.prefix.tex);
    this.prefix = null;
    this.lastPreviewKeys = [];
  }

  private makeEnv(width: number, height: number, scale: number, face: FaceAnalysis | null): PassEnv {
    return {
      gpu: this.gpu,
      width,
      height,
      scale,
      sourceDiagonal: Math.hypot(this.originalSize.width, this.originalSize.height),
      face,
      cache: this.passCache,
      luts: this.lutProvider,
    };
  }

  private readonly passCache: PassCache = {
    get: <T>(key: string, create: () => T, dispose?: (value: T) => void): T => {
      const hit = this.cacheEntries.get(key);
      if (hit) return hit.value as T;
      const value = create();
      this.cacheEntries.set(key, { value, dispose: dispose as ((v: unknown) => void) | undefined });
      return value;
    },
  };

  private clearCache(): void {
    for (const e of this.cacheEntries.values()) e.dispose?.(e.value);
    this.cacheEntries.clear();
    this.cacheToken = '';
  }

  private readonly lutProvider: LutProvider = {
    getLut: (lookId: string): GpuTexture | null => {
      const cached = this.lutTextures.get(lookId);
      if (cached) return cached;
      let lut: LutData | undefined;
      if (lookId.startsWith('custom:')) lut = this.customLuts.get(lookId);
      else lut = buildLookLut(lookId);
      if (!lut) return null;
      const tex = this.gpu.createLut3D(lut.size, lut.data);
      this.lutTextures.set(lookId, tex);
      return tex;
    },
  };
}

/**
 * Built-in looks are deterministic, so their LUT data is built once per page
 * and shared by every Renderer (main preview, thumbnails, export).
 */
const lookLutMemo = new Map<string, LutData | null>();

function buildLookLut(lookId: string): LutData | undefined {
  if (!lookLutMemo.has(lookId)) lookLutMemo.set(lookId, getLook(lookId)?.build() ?? null);
  return lookLutMemo.get(lookId) ?? undefined;
}

function rectKey(r: PixelRect): string {
  return `${r.x},${r.y},${r.width}x${r.height}`;
}

/**
 * keys[i] identifies the texture entering stack[i] (keys[stack.length] the
 * result): the frame plus every layer before it.
 */
function stackKeys(frameKey: string, stack: readonly AnyLayer[]): string[] {
  const keys = [frameKey];
  for (const l of stack) keys.push(`${keys[keys.length - 1]}|${JSON.stringify([l.id, l.kind, l.opacity, l.params])}`);
  return keys;
}

function leadingMatches(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * A warp cannot be faded by blending pixels, which superimposes the old and
 * the new geometry. Its displacement is linear in the reshape parameters
 * (the folding guard only ever weakens it), so scale those instead.
 */
function fadedWarp(layer: Layer<'faceReshape'>): Layer<'faceReshape'> {
  const o = Math.min(1, Math.max(0, layer.opacity));
  const { slim, eyes, nose, chin } = layer.params;
  return { ...layer, opacity: 1, params: { ...layer.params, slim: slim * o, eyes: eyes * o, nose: nose * o, chin: chin * o } };
}

/**
 * `analysis` in the coordinates of `region` (normalised to the whole image):
 * a translation and scale, so faces keep their shape and orientation.
 */
function cropAnalysis(analysis: FaceAnalysis, region: { x: number; y: number; width: number; height: number }): FaceAnalysis {
  const point = (p: Point2): Point2 => ({ x: (p.x - region.x) / region.width, y: (p.y - region.y) / region.height });
  return {
    ...analysis,
    imageWidth: analysis.imageWidth * region.width,
    imageHeight: analysis.imageHeight * region.height,
    faces: analysis.faces.map((face) => ({
      ...face,
      landmarks: face.landmarks.map(point),
      box: { ...point(face.box), width: face.box.width / region.width, height: face.box.height / region.height },
    })),
  };
}

function drawScaled(source: TexImageSource, width: number, height: number): TexImageSource {
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('2D canvas unavailable for downscaling');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return canvas;
}
