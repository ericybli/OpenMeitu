import { createDocument, createLayer, removeLayer, resetLayer, upsertLayer, type EditDocument } from '../engine/document';
import { History } from '../engine/history';
import { applyPreset, BUILTIN_PRESETS, documentToPreset, parsePreset, type Preset } from '../engine/preset';
import type { Renderer } from '../engine/renderer';
import {
  DEFAULT_PARAMS,
  isIdentityLayer,
  ORIGINAL_LOOK_ID,
  PARAM_SPECS,
  type AnyLayer,
  type CropRect,
  type Layer,
  type LayerKind,
  type LayerParams,
  type TransformParams,
} from '../engine/types';
import type { FaceDetector } from '../face/detector';
import type { FaceAnalysis } from '../face/types';
import { parseCube, type CubeLut } from '../filters/cube';
import { listLooks } from '../filters/looks';
import type { LutData } from '../filters/lut';
import {
  htmlLang,
  isLanguage,
  languageFromLocale,
  translate,
  type Language,
  type MessageKey,
  type MessageParams,
} from '../ui/i18n';
import {
  aspectRatioOf,
  centeredRect,
  flipRectH,
  flipRectV,
  normalizeCrop,
  normalizedRatio,
  rotateRectCCW,
  rotateRectCW,
  type CropAspect,
  type Size,
} from './crop';
import {
  afterNextPaint,
  baseName,
  classifyFile,
  decodeImage,
  downloadBlob,
  encodePixels,
  errorMessage,
  nextFrame,
  safeFileName,
  type ExportFormat,
} from './io';
import { ThumbnailRenderer } from './thumbnails';

export const TOOLS = ['beauty', 'adjust', 'filters', 'effects', 'crop', 'presets'] as const;
export type ToolId = (typeof TOOLS)[number];

export type FaceStatus = 'idle' | 'detecting' | 'found' | 'none' | 'error';

export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: MessageKey;
  params?: MessageParams;
}

/** An imported .cube LUT, usable as the filter look `lookId` (= `custom:<id>`). */
export interface CustomLook {
  id: string;
  lookId: string;
  name: string;
}

export interface EditorState {
  readonly doc: EditDocument;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Full-resolution, EXIF-oriented source image. */
  readonly image: ImageBitmap | null;
  /** Increments every time a new image is opened. */
  readonly imageId: number;
  readonly fileName: string | null;
  readonly loading: boolean;
  readonly face: FaceAnalysis | null;
  readonly faceStatus: FaceStatus;
  readonly faceError: string | null;
  readonly tool: ToolId;
  /** Show the original image (Space / Compare button). */
  readonly compare: boolean;
  readonly cropAspect: CropAspect;
  readonly language: Language;
  readonly toasts: readonly Toast[];
  readonly customLooks: readonly CustomLook[];
  /** Data URLs keyed by look id or `preset:<index>`, for the current image. */
  readonly thumbnails: Readonly<Record<string, string>>;
  readonly exporting: boolean;
  /** Warnings from the most recent preset import. */
  readonly presetWarnings: readonly string[];
}

const LANGUAGE_STORAGE_KEY = 'openmeitu.language';
const TOAST_MS = { info: 4000, success: 3500, error: 7000 } as const;
const MAX_TOASTS = 4;
const CUSTOM_LOOK_PREFIX = 'custom:';
/** Hand-made face edits that one-tap presets without such a layer leave in place. */
const PRESET_KEEPS: readonly LayerKind[] = ['faceReshape', 'teethWhiten'];

/** One undo step: the document and the crop aspect lock that goes with it. */
interface Snapshot {
  readonly doc: EditDocument;
  readonly cropAspect: CropAspect;
}

export function presetThumbnailKey(index: number): string {
  return `preset:${index}`;
}

/** Localised display name of a preset. */
export function presetName(preset: Preset, language: Language): string {
  return preset.names?.[language] ?? preset.name;
}

export function findLayer<K extends LayerKind>(doc: EditDocument, kind: K): Layer<K> | undefined {
  return doc.layers.find((l): l is Layer<K> & AnyLayer => l.kind === kind);
}

/**
 * Application state for the editor UI. Framework-agnostic; React reads it
 * through `useSyncExternalStore(store.subscribe, store.getState)`.
 */
export class EditorStore {
  private state: EditorState;
  private readonly listeners = new Set<() => void>();
  private readonly history: History<Snapshot>;
  /**
   * Control whose drag/keyboard gesture is in progress (e.g. `param:adjust.exposure`).
   * Its later changes replace the undo step; a change to any other control starts a
   * new one, so a missed gesture-end event can never merge unrelated edits.
   */
  private gesture: string | null = null;

  private renderer: Renderer | null = null;
  private detector: Promise<FaceDetector> | null = null;
  private thumbnailRenderer: ThumbnailRenderer | null = null;
  private thumbnailsFor = -1;
  private thumbnailRun = 0;
  private readonly customLuts = new Map<string, LutData>();
  private openRequest = 0;
  private largeImageNotified = -1;
  private toastCounter = 0;
  private readonly toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private unloadGuarded = false;

  constructor() {
    const doc = createDocument();
    this.history = new History<Snapshot>({ doc, cropAspect: 'free' });
    this.state = {
      doc,
      canUndo: false,
      canRedo: false,
      image: null,
      imageId: 0,
      fileName: null,
      loading: false,
      face: null,
      faceStatus: 'idle',
      faceError: null,
      tool: 'beauty',
      compare: false,
      cropAspect: 'free',
      language: initialLanguage(),
      toasts: [],
      customLooks: [],
      thumbnails: {},
      exporting: false,
      presetWarnings: [],
    };
    applyDocumentLanguage(this.state.language);
  }

  // ------------------------------------------------------------ subscription

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): EditorState => this.state;

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private get doc(): EditDocument {
    return this.history.present.doc;
  }

  private syncDocument(): void {
    const { doc, cropAspect } = this.history.present;
    this.set({ doc, cropAspect, canUndo: this.history.canUndo, canRedo: this.history.canRedo });
    this.guardUnload();
  }

  /**
   * True while closing the tab or opening another photo would throw away edits:
   * any layer that changes the photo when shown (hidden layers count too).
   */
  private hasEdits(): boolean {
    return this.state.image !== null && this.doc.layers.some((layer) => !isIdentityLayer({ ...layer, enabled: true, opacity: 1 }));
  }

  private readonly onBeforeUnload = (event: BeforeUnloadEvent): void => {
    event.preventDefault();
    event.returnValue = true; // Older browsers only prompt when returnValue is set.
  };

  /** Ask before leaving the page only while there are edits to lose. */
  private guardUnload(): void {
    const guard = this.hasEdits();
    if (guard === this.unloadGuarded || typeof window === 'undefined') return;
    this.unloadGuarded = guard;
    if (guard) window.addEventListener('beforeunload', this.onBeforeUnload);
    else window.removeEventListener('beforeunload', this.onBeforeUnload);
  }

  // ------------------------------------------------------------ renderer

  /** Called by the canvas view once its WebGL renderer exists (again after a GPU context reset). */
  attachRenderer(renderer: Renderer): void {
    this.renderer = renderer;
    for (const [id, lut] of this.customLuts) renderer.registerCustomLut(id, lut);
    const { image, face, fileName } = this.state;
    if (!image) return;
    if (this.loadSource(renderer, image, fileName)) {
      renderer.setAnalysis(face);
      this.notifyIfDownscaled();
    } else {
      this.showImage(null, null);
    }
  }

  /** Upload `image` to `renderer`; a failure (e.g. too large to downscale) becomes a toast. */
  private loadSource(renderer: Renderer, image: ImageBitmap, fileName: string | null): boolean {
    try {
      renderer.setSource(image);
      return true;
    } catch (error) {
      this.toast('error', 'toast.openFailed', { name: fileName ?? '', detail: errorMessage(error) });
      return false;
    }
  }

  detachRenderer(renderer: Renderer): void {
    if (this.renderer === renderer) this.renderer = null;
  }

  /** Full-resolution output size of the current edit, or null without an image. */
  measureOutput(): Size | null {
    if (!this.renderer?.hasSource) return null;
    try {
      return this.renderer.measureOutput(this.state.doc.layers);
    } catch {
      return null;
    }
  }

  reportRenderError(detail: string): void {
    this.toast('error', 'toast.renderFailed', { detail });
  }

  private notifyIfDownscaled(): void {
    const { image, imageId } = this.state;
    if (!image || !this.renderer || this.largeImageNotified === imageId) return;
    const max = this.renderer.gpu.maxTextureSize;
    const longEdge = Math.max(image.width, image.height);
    if (longEdge <= max) return;
    this.largeImageNotified = imageId;
    const s = max / longEdge;
    this.toast('info', 'toast.largeImage', {
      width: Math.max(1, Math.floor(image.width * s)),
      height: Math.max(1, Math.floor(image.height * s)),
    });
  }

  // ------------------------------------------------------------ opening images

  async openFile(file: File): Promise<void> {
    const kind = classifyFile(file);
    if (kind === 'other') {
      this.toast('error', 'toast.notImage', { name: file.name });
      return;
    }
    // Every way of opening a photo (picker, drop, paste, shortcut) ends up here.
    if (this.hasEdits() && !confirm(translate(this.state.language, 'confirm.discardEdits', { name: file.name }))) return;
    const request = ++this.openRequest;
    this.set({ loading: true });
    let bitmap: ImageBitmap;
    try {
      bitmap = await decodeImage(file);
    } catch {
      if (request === this.openRequest) this.set({ loading: false });
      this.toast('error', kind === 'heic' ? 'toast.heic' : 'toast.decodeFailed', { name: file.name });
      return;
    }
    if (request !== this.openRequest) {
      bitmap.close();
      return;
    }
    // Upload before touching any state, so a failure keeps the current photo and its edits.
    if (this.renderer && !this.loadSource(this.renderer, bitmap, file.name)) {
      bitmap.close(); // setSource is exception-safe: the current photo stays loaded.
      this.set({ loading: false });
      return;
    }
    const imageId = this.showImage(bitmap, file.name);
    if (this.renderer) {
      this.renderer.setAnalysis(null);
      this.notifyIfDownscaled();
    }
    void this.detectFaces(imageId, bitmap);
  }

  /**
   * Start a fresh session for `image` (null = back to the empty state): new
   * history and per-photo UI state; the previous bitmap is released. Returns the new image id.
   */
  private showImage(image: ImageBitmap | null, fileName: string | null): number {
    const previous = this.state.image;
    const imageId = this.state.imageId + 1;
    this.gesture = null;
    this.history.reset({ doc: createDocument(), cropAspect: 'free' });
    this.thumbnailRun++;
    this.set({
      image,
      imageId,
      fileName,
      loading: false,
      face: null,
      faceStatus: image ? 'detecting' : 'idle',
      faceError: null,
      compare: false,
      cropAspect: 'free',
      thumbnails: {},
      presetWarnings: [],
      doc: this.doc,
      canUndo: false,
      canRedo: false,
    });
    this.guardUnload();
    if (previous !== image) previous?.close();
    return imageId;
  }

  private async detectFaces(imageId: number, bitmap: ImageBitmap): Promise<void> {
    let detector: FaceDetector;
    try {
      // MediaPipe is large: load it only once the first photo needs it.
      this.detector ??= import('../face/detector').then(({ createFaceDetector }) => createFaceDetector());
      detector = await this.detector;
    } catch (error) {
      // Let the next photo retry (e.g. after a transient model download failure).
      this.detector = null;
      this.failDetection(imageId, error);
      return;
    }
    try {
      // Detection blocks the main thread: show the new photo first.
      await afterNextPaint();
      // A newer image may have been opened (and this bitmap closed) meanwhile.
      if (imageId !== this.state.imageId) return;
      const analysis = await detector.detect(bitmap);
      if (imageId !== this.state.imageId) return;
      this.renderer?.setAnalysis(analysis);
      this.set({ face: analysis, faceStatus: analysis.faces.length > 0 ? 'found' : 'none' });
      // Thumbnails made before the face was known are framed on a guess: redo them around the face.
      if (analysis.faces.length > 0 && this.thumbnailsFor === imageId) {
        this.thumbnailsFor = -1;
        this.ensureThumbnails();
      }
    } catch (error) {
      this.failDetection(imageId, error);
    }
  }

  private failDetection(imageId: number, error: unknown): void {
    if (imageId === this.state.imageId) this.set({ face: null, faceStatus: 'error', faceError: errorMessage(error) });
  }

  // ------------------------------------------------------------ edits & history

  /**
   * Record `doc`, together with the crop aspect lock that belongs to it, as the
   * new present. With a `gesture` key, changes continuing the open gesture of
   * that same control replace the current undo step instead of adding one; any
   * other change pushes a step and closes the gesture. A change of the aspect
   * lock alone is not an undo step.
   */
  private commit(doc: EditDocument, gesture: string | null = null, cropAspect = this.state.cropAspect): void {
    if (doc === this.doc) {
      if (cropAspect !== this.state.cropAspect) this.set({ cropAspect });
      return;
    }
    const snapshot: Snapshot = { doc, cropAspect };
    if (gesture !== null && gesture === this.gesture) {
      this.history.replace(snapshot);
    } else {
      this.history.push(snapshot);
      this.gesture = gesture;
    }
    this.syncDocument();
  }

  /** Finish a slider/crop drag: the next change starts a new undo step. */
  endGesture(): void {
    this.gesture = null;
  }

  /**
   * Set one numeric parameter; `gesture` coalesces a drag into one undo step.
   * A hidden layer (switched off or faded to 0) is shown again so the change is visible.
   */
  setParam(kind: LayerKind, param: string, value: number, gesture = false): void {
    if (!this.state.image) return;
    const spec = (PARAM_SPECS[kind] as Record<string, { min: number; max: number } | undefined>)[param];
    if (!spec || !Number.isFinite(value)) return;
    const clamped = Math.min(spec.max, Math.max(spec.min, value));
    const doc = this.doc;
    const layer = findLayer(doc, kind);
    const current = (layer?.params ?? DEFAULT_PARAMS[kind]) as unknown as Record<string, unknown>;
    if (current[param] === clamped) return;
    const params = { [param]: clamped } as Partial<LayerParams[LayerKind]>;
    this.commit(upsertLayer(doc, kind, { params, ...revealed(layer) }), gesture ? `param:${kind}.${param}` : null);
  }

  setLayerEnabled(kind: LayerKind, enabled: boolean): void {
    const doc = this.doc;
    const layer = findLayer(doc, kind);
    if (!layer || layer.enabled === enabled) return;
    this.commit(upsertLayer(doc, kind, { enabled }));
  }

  setLayerOpacity(kind: LayerKind, opacity: number, gesture = false): void {
    const doc = this.doc;
    const layer = findLayer(doc, kind);
    const value = Math.min(1, Math.max(0, opacity));
    if (!layer || layer.opacity === value) return;
    this.commit(upsertLayer(doc, kind, { opacity: value }), gesture ? `opacity:${kind}` : null);
  }

  resetLayer(kind: LayerKind): void {
    if (!findLayer(this.doc, kind)) return;
    this.commit(resetLayer(this.doc, kind), null, kind === 'transform' ? 'free' : this.state.cropAspect);
  }

  removeLayer(kind: LayerKind): void {
    if (!findLayer(this.doc, kind)) return;
    this.commit(removeLayer(this.doc, kind), null, kind === 'transform' ? 'free' : this.state.cropAspect);
  }

  resetAll(): void {
    if (this.doc.layers.length === 0) return;
    this.commit(createDocument(), null, 'free');
  }

  undo(): void {
    this.gesture = null;
    if (this.history.canUndo && this.history.undo() !== undefined) this.syncDocument();
  }

  redo(): void {
    this.gesture = null;
    if (this.history.canRedo && this.history.redo() !== undefined) this.syncDocument();
  }

  // ------------------------------------------------------------ crop & geometry

  /** Geometry as rendered: a switched-off transform layer counts as no transform. */
  private transform(): TransformParams {
    const layer = findLayer(this.doc, 'transform');
    return layer?.enabled ? layer.params : DEFAULT_PARAMS.transform;
  }

  /**
   * Change the geometry as rendered. A switched-off transform layer is
   * switched back on, starting from no transform (what the user sees).
   */
  private updateTransform(
    params: Partial<TransformParams>,
    gesture: string | null = null,
    cropAspect = this.state.cropAspect,
  ): void {
    const layer = findLayer(this.doc, 'transform');
    const patch = { params: { ...this.transform(), ...params }, ...revealed(layer) };
    this.commit(upsertLayer(this.doc, 'transform', patch), gesture, cropAspect);
  }

  /** Size of the image after rotation (the space crop rectangles live in). */
  orientedSize(): Size | null {
    const { image } = this.state;
    if (!image) return null;
    const quarter = this.transform().rotate % 180 !== 0;
    return quarter ? { width: image.height, height: image.width } : { width: image.width, height: image.height };
  }

  /** Normalised width/height ratio the crop frame is locked to, or null. */
  cropRatio(aspect: CropAspect = this.state.cropAspect): number | null {
    const size = this.orientedSize();
    if (!size) return null;
    const pixelRatio = aspectRatioOf(aspect, size);
    return pixelRatio === null ? null : normalizedRatio(pixelRatio, size);
  }

  /** Rotate what the user sees by 90° clockwise (1) or counter-clockwise (-1). */
  rotate(direction: 1 | -1): void {
    if (!this.state.image) return;
    const t = this.transform();
    // rotate is applied before flip, so with a single flip the visual direction inverts.
    const visualToStored = t.flipH !== t.flipV ? -1 : 1;
    const rotate = ((((t.rotate + direction * visualToStored * 90) % 360) + 360) % 360) as TransformParams['rotate'];
    const crop = t.crop && (direction === 1 ? rotateRectCW(t.crop) : rotateRectCCW(t.crop));
    this.updateTransform({ rotate, crop }, null, rotatedAspect(this.state.cropAspect));
  }

  flip(axis: 'horizontal' | 'vertical'): void {
    if (!this.state.image) return;
    const t = this.transform();
    this.updateTransform(
      axis === 'horizontal'
        ? { flipH: !t.flipH, crop: t.crop && flipRectH(t.crop) }
        : { flipV: !t.flipV, crop: t.crop && flipRectV(t.crop) },
    );
  }

  setCrop(rect: CropRect | null, gesture = false): void {
    if (!this.state.image) return;
    const crop = normalizeCrop(rect);
    if (sameRect(this.transform().crop, crop)) return;
    this.updateTransform({ crop }, gesture ? 'crop' : null);
  }

  setCropAspect(aspect: CropAspect): void {
    const ratio = this.cropRatio(aspect);
    const crop = ratio === null ? undefined : normalizeCrop(centeredRect(ratio));
    if (crop === undefined || sameRect(this.transform().crop, crop)) this.set({ cropAspect: aspect });
    else this.updateTransform({ crop }, null, aspect);
  }

  // ------------------------------------------------------------ looks & presets

  /**
   * Pick a filter look. A different look starts at full intensity, as its tile
   * shows it; picking the current look again keeps the intensity.
   */
  selectLook(lookId: string): void {
    if (!this.state.image) return;
    const doc = this.doc;
    const layer = findLayer(doc, 'filter');
    if (lookId === ORIGINAL_LOOK_ID) {
      if (layer) this.commit(removeLayer(doc, 'filter'));
      return;
    }
    const params = layer?.params.lookId === lookId ? {} : { lookId, intensity: 1 };
    this.commit(upsertLayer(doc, 'filter', { params, ...revealed(layer) }));
  }

  /** Apply a one-tap preset. Hand-made face edits stay unless the preset sets those layers itself. */
  applyPreset(preset: Preset): void {
    if (!this.state.image) return;
    this.commit(applyPreset(this.doc, preset, 'replace', { keep: PRESET_KEEPS }));
    this.toast('success', 'presets.applied', { name: presetName(preset, this.state.language) });
  }

  async importPresetFile(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      this.toast('error', 'presets.invalid', { detail: errorMessage(error) });
      return;
    }
    const result = parsePreset(text);
    if (!result.ok) {
      this.toast('error', 'presets.invalid', { detail: result.error });
      return;
    }
    let { preset } = result;
    const warnings = [...result.warnings];
    // Presets only name imported LUTs; without that LUT here the filter would silently do nothing.
    const presetLutId = customLutId(preset.layers.find((layer) => layer.kind === 'filter')?.params.lookId);
    if (presetLutId !== null && !this.customLuts.has(presetLutId)) {
      preset = { ...preset, layers: preset.layers.filter((layer) => layer.kind !== 'filter') };
      warnings.push(translate(this.state.language, 'presets.missingLut', { name: lutNameFromId(presetLutId) }));
    }
    const name = presetName(preset, this.state.language);
    this.set({ presetWarnings: warnings });
    if (this.state.image) this.commit(applyPreset(this.doc, preset, 'replace'));
    if (warnings.length > 0) {
      this.toast('info', 'presets.warnings', { name, count: warnings.length });
    } else {
      this.toast('success', 'presets.applied', { name });
    }
  }

  /** Download the current edit as a preset file named after `name`. */
  exportPreset(name: string): void {
    const presetTitle = name.trim() || 'OpenMeitu preset';
    const preset = documentToPreset(this.doc, presetTitle);
    const fileName = `${safeFileName(presetTitle, 'preset')}.json`;
    downloadBlob(new Blob([`${JSON.stringify(preset, null, 2)}\n`], { type: 'application/json' }), fileName);
    this.toast('success', 'presets.saved', { name: fileName });
    if (preset.layers.some((layer) => layer.kind === 'filter' && customLutId(layer.params.lookId) !== null)) {
      this.toast('info', 'presets.lutNotShared');
    }
  }

  async importCubeFile(file: File): Promise<void> {
    let lut: CubeLut;
    try {
      lut = parseCube(await file.text());
    } catch (error) {
      this.toast('error', 'presets.lutInvalid', { detail: errorMessage(error) });
      return;
    }
    const name = lut.title?.trim() || baseName(file.name);
    const id = lutId(file.name, lut);
    const lookId = `${CUSTOM_LOOK_PREFIX}${id}`;
    const known = this.customLuts.has(id);
    if (!known) {
      this.customLuts.set(id, lut);
      this.renderer?.registerCustomLut(id, lut);
      this.thumbnailRenderer?.registerLut(id, lut);
      this.set({ customLooks: [...this.state.customLooks, { id, lookId, name }] });
    }
    if (this.state.image) {
      const layer = findLayer(this.doc, 'filter');
      this.commit(upsertLayer(this.doc, 'filter', { params: { lookId, intensity: 1 }, ...revealed(layer) }));
    }
    if (!known && this.thumbnailsFor === this.state.imageId) {
      void this.renderThumbnails([{ key: lookId, layers: [createLayer('filter', { lookId, intensity: 1 })] }]);
    }
    this.toast('success', 'presets.lutImported', { name });
  }

  // ------------------------------------------------------------ thumbnails

  /** Render look and preset thumbnails for the current image (once per image). */
  ensureThumbnails(): void {
    const { image, imageId } = this.state;
    if (!image || this.thumbnailsFor === imageId) return;
    this.thumbnailsFor = imageId;
    const jobs: ThumbnailJob[] = [
      ...listLooks().map((look) => ({
        key: look.id,
        layers: look.id === ORIGINAL_LOOK_ID ? [] : [createLayer('filter', { lookId: look.id, intensity: 1 })],
      })),
      ...this.state.customLooks.map((look) => ({
        key: look.lookId,
        layers: [createLayer('filter', { lookId: look.lookId, intensity: 1 })],
      })),
      ...BUILTIN_PRESETS.map((preset, index) => ({
        key: presetThumbnailKey(index),
        layers: applyPreset(createDocument(), preset, 'replace').layers,
      })),
    ];
    void this.renderThumbnails(jobs, true);
  }

  private async renderThumbnails(jobs: readonly ThumbnailJob[], fresh = false): Promise<void> {
    const { image, imageId, face } = this.state;
    if (!image) return;
    const run = fresh ? ++this.thumbnailRun : this.thumbnailRun;
    try {
      if (!this.thumbnailRenderer) {
        this.thumbnailRenderer = new ThumbnailRenderer();
        for (const [id, lut] of this.customLuts) this.thumbnailRenderer.registerLut(id, lut);
      }
      if (fresh) this.thumbnailRenderer.setImage(image, face);
      for (const job of jobs) {
        // Yield between tiles so the UI stays responsive while LUTs are built.
        await nextFrame();
        if (run !== this.thumbnailRun || imageId !== this.state.imageId || !this.thumbnailRenderer) return;
        const url = this.thumbnailRenderer.render(job.layers);
        this.set({ thumbnails: { ...this.state.thumbnails, [job.key]: url } });
      }
    } catch {
      // Thumbnails are decorative: tiles keep their placeholder and still work. Drop the
      // renderer (its GPU context may have been lost) so the next photo starts afresh.
      this.thumbnailRenderer?.dispose();
      this.thumbnailRenderer = null;
    }
  }

  // ------------------------------------------------------------ export

  async exportImage(format: ExportFormat, quality: number): Promise<void> {
    const { image, imageId, fileName, exporting } = this.state;
    if (!image || exporting) return;
    if (!this.renderer) {
      this.toast('error', 'export.unavailable');
      return;
    }
    this.set({ exporting: true });
    try {
      // Let the button show its busy state before the (blocking) full-res render.
      await nextFrame();
      // The photo may have been replaced, or the GPU context lost, while waiting.
      if (imageId !== this.state.imageId) return;
      const renderer = this.renderer;
      if (!renderer) {
        this.toast('error', 'export.unavailable');
        return;
      }
      const pixels = renderer.renderToPixels(this.doc.layers);
      const blob = await encodePixels(pixels, format, quality);
      const name = `${baseName(fileName)}-openmeitu.${format === 'jpeg' ? 'jpg' : 'png'}`;
      downloadBlob(blob, name);
      this.toast('success', 'export.done', { name });
    } catch (error) {
      this.toast('error', 'export.failed', { detail: errorMessage(error) });
    } finally {
      this.set({ exporting: false });
    }
  }

  // ------------------------------------------------------------ UI state

  setTool(tool: ToolId): void {
    if (tool !== this.state.tool) {
      this.gesture = null;
      this.set({ tool });
    }
  }

  setCompare(compare: boolean): void {
    if (compare !== this.state.compare && (this.state.image || !compare)) this.set({ compare });
  }

  setLanguage(language: Language): void {
    if (language === this.state.language) return;
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Storage may be unavailable (private mode); the choice then lasts for this visit.
    }
    applyDocumentLanguage(language);
    this.set({ language });
  }

  toast(tone: ToastTone, message: MessageKey, params?: MessageParams): void {
    const id = ++this.toastCounter;
    const kept = this.state.toasts.slice(-(MAX_TOASTS - 1));
    for (const dropped of this.state.toasts.slice(0, this.state.toasts.length - kept.length)) {
      this.clearToastTimer(dropped.id);
    }
    this.set({ toasts: [...kept, { id, tone, message, params }] });
    this.resumeToast(id);
  }

  dismissToast(id: number): void {
    this.clearToastTimer(id);
    if (this.state.toasts.some((t) => t.id === id)) {
      this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
    }
  }

  /** Keep a toast up (e.g. while it is hovered or focused) until `resumeToast`. */
  pauseToast(id: number): void {
    this.clearToastTimer(id);
  }

  /** (Re)start a toast's auto-dismiss countdown from its full duration. */
  resumeToast(id: number): void {
    const toast = this.state.toasts.find((t) => t.id === id);
    if (!toast || this.toastTimers.has(id)) return;
    this.toastTimers.set(
      id,
      setTimeout(() => this.dismissToast(id), TOAST_MS[toast.tone]),
    );
  }

  private clearToastTimer(id: number): void {
    const timer = this.toastTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.toastTimers.delete(id);
  }

  /** Release GPU, model and timer resources. The store stays usable and re-creates them lazily. */
  dispose(): void {
    for (const timer of this.toastTimers.values()) clearTimeout(timer);
    this.toastTimers.clear();
    if (this.unloadGuarded) {
      window.removeEventListener('beforeunload', this.onBeforeUnload);
      this.unloadGuarded = false;
    }
    this.thumbnailRun++;
    this.thumbnailsFor = -1;
    this.thumbnailRenderer?.dispose();
    this.thumbnailRenderer = null;
    const detector = this.detector;
    this.detector = null;
    detector?.then((d) => d.close()).catch(() => undefined);
  }
}

interface ThumbnailJob {
  key: string;
  layers: readonly AnyLayer[];
}

function initialLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // Storage blocked: fall back to the browser locale.
  }
  return languageFromLocale(typeof navigator !== 'undefined' ? navigator.language : undefined);
}

function applyDocumentLanguage(language: Language): void {
  if (typeof document !== 'undefined') document.documentElement.lang = htmlLang(language);
}

/** Portrait/landscape counterpart of a locked aspect after a 90° turn. */
function rotatedAspect(aspect: CropAspect): CropAspect {
  switch (aspect) {
    case '9:16':
      return '16:9';
    case '16:9':
      return '9:16';
    case '4:5':
    case '3:4':
      return 'free';
    default:
      return aspect;
  }
}

/** Patch that shows a hidden layer: switched on, and back at full opacity if it was faded out completely. */
function revealed(layer: Pick<AnyLayer, 'opacity'> | undefined): { enabled: true; opacity?: number } {
  return layer && layer.opacity <= 0 ? { enabled: true, opacity: 1 } : { enabled: true };
}

/** Id of the imported LUT a filter look id refers to (`custom:<id>`), or null for built-in looks. */
function customLutId(lookId: unknown): string | null {
  return typeof lookId === 'string' && lookId.startsWith(CUSTOM_LOOK_PREFIX) ? lookId.slice(CUSTOM_LOOK_PREFIX.length) : null;
}

/**
 * Id for an imported LUT: its file name plus a hash of its contents, so the
 * same .cube file gets the same id in every session and shared presets find it.
 */
function lutId(fileName: string, lut: LutData): string {
  const slug = baseName(fileName).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  let hash = Math.imul(0x811c9dc5 ^ lut.size, 0x01000193); // FNV-1a
  for (const byte of lut.data) hash = Math.imul(hash ^ byte, 0x01000193);
  return `${slug || 'lut'}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Readable name of an imported LUT that isn't loaded: the file name part of its id, else the id. */
function lutNameFromId(id: string): string {
  return /^(.+)-[0-9a-f]{8}$/.exec(id)?.[1] ?? id;
}

function sameRect(a: CropRect | null, b: CropRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
