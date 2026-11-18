import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStore, findLayer } from '../../src/app/store';
import { BUILTIN_PRESETS, PRESET_FORMAT, PRESET_VERSION } from '../../src/engine/preset';
import type { FaceAnalysis } from '../../src/face/types';

const detector = vi.hoisted(() => ({
  detect: vi.fn(async (image: { width: number; height: number }): Promise<FaceAnalysis> => ({
    imageWidth: image.width,
    imageHeight: image.height,
    faces: [],
  })),
  close: vi.fn(),
}));
vi.mock('../../src/face/detector', () => ({ createFaceDetector: async () => detector }));

let frames: (() => void)[] = [];
let decode: ReturnType<typeof vi.fn>;
let confirmDialog: ReturnType<typeof vi.fn>;
let store: EditorStore;

function runFrames(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback();
}

function imageFile(name: string): File {
  return new File([new Uint8Array(8)], name, { type: 'image/png' });
}

/** Open a `width` x `height` photo (decoding is stubbed). */
async function open(name = 'a.png', width = 400, height = 200): Promise<void> {
  decode.mockResolvedValueOnce({ width, height, close: vi.fn() });
  await store.openFile(imageFile(name));
}

/** A 2x2x2 .cube; `shift` makes LUTs with different contents. */
function cubeFile(name: string, shift = 0): File {
  const rows = ['LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${1 - r} ${Math.abs(g - shift)} ${b}`);
  return new File([rows.join('\n')], name);
}

function presetFile(layers: unknown[]): File {
  return new File([JSON.stringify({ format: PRESET_FORMAT, version: PRESET_VERSION, name: 'Shared', layers })], 'shared.json');
}

const layerKinds = () => store.getState().doc.layers.map((layer) => layer.kind);

beforeEach(() => {
  frames = [];
  decode = vi.fn();
  confirmDialog = vi.fn(() => true);
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('confirm', confirmDialog);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  detector.detect.mockClear();
  store = new EditorStore();
});

afterEach(() => {
  store.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('opening photos', () => {
  it('decodes with straight alpha, upright and in sRGB', async () => {
    await open();
    expect(decode).toHaveBeenCalledWith(expect.any(File), {
      imageOrientation: 'from-image',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'default',
    });
  });

  it('asks before replacing a photo with edits, in the UI language, and keeps it when declined', async () => {
    await open('first.png');
    await open('second.png');
    expect(confirmDialog).not.toHaveBeenCalled();

    store.setLanguage('zh');
    store.setParam('skinSmooth', 'amount', 0.5);
    confirmDialog.mockReturnValueOnce(false);
    await store.openFile(imageFile('third.png'));
    expect(confirmDialog).toHaveBeenCalledWith('打开「third.png」？当前照片的修图效果将被丢弃。');
    expect(decode).toHaveBeenCalledTimes(2);
    expect(store.getState().fileName).toBe('second.png');
    expect(layerKinds()).toEqual(['skinSmooth']);

    await open('third.png');
    expect(store.getState().fileName).toBe('third.png');
    expect(layerKinds()).toEqual([]);
  });

  it('does not ask when the only layers change nothing', async () => {
    await open();
    store.setParam('skinSmooth', 'amount', 0.5);
    store.setParam('skinSmooth', 'amount', 0);
    await open('second.png');
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('asks for hidden edits too', async () => {
    await open();
    store.setParam('skinSmooth', 'amount', 0.5);
    store.setLayerEnabled('skinSmooth', false);
    await open('second.png');
    expect(confirmDialog).toHaveBeenCalledTimes(1);
  });

  it('guards closing the page only while there are edits', async () => {
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true });
      page.dispatchEvent(event);
      return event.defaultPrevented;
    };
    await open();
    expect(unload()).toBe(false);
    store.setParam('adjust', 'exposure', 0.4);
    expect(unload()).toBe(true);
    store.setLayerOpacity('adjust', 0);
    expect(unload()).toBe(true);
    store.undo();
    store.undo();
    expect(unload()).toBe(false);
    store.redo();
    expect(unload()).toBe(true);
    store.dispose();
    expect(unload()).toBe(false);
  });

  it('starts face detection only after the new photo has been painted', async () => {
    await open();
    await vi.waitFor(() => expect(frames.length + detector.detect.mock.calls.length).toBeGreaterThan(0));
    expect(detector.detect).not.toHaveBeenCalled();
    runFrames();
    await vi.waitFor(() => expect(detector.detect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.getState().faceStatus).toBe('none'));
  });
});

describe('editing hidden layers', () => {
  it('shows a switched-off layer again when its control changes, in the same undo step', async () => {
    await open();
    store.setParam('skinWhiten', 'amount', 0.4);
    store.setLayerEnabled('skinWhiten', false);
    store.setParam('skinWhiten', 'amount', 0.8, true);
    store.setParam('skinWhiten', 'amount', 0.9, true);
    expect(findLayer(store.getState().doc, 'skinWhiten')).toMatchObject({ enabled: true, params: { amount: 0.9 } });
    store.undo();
    expect(findLayer(store.getState().doc, 'skinWhiten')).toMatchObject({ enabled: false, params: { amount: 0.4 } });
  });

  it('brings a layer faded to 0 back to full opacity, but keeps other opacities', async () => {
    await open();
    store.setParam('faceReshape', 'slim', 0.2);
    store.setLayerOpacity('faceReshape', 0);
    store.setParam('faceReshape', 'eyes', 0.3);
    expect(findLayer(store.getState().doc, 'faceReshape')?.opacity).toBe(1);
    store.setLayerOpacity('faceReshape', 0.5);
    store.setParam('faceReshape', 'eyes', 0.4);
    expect(findLayer(store.getState().doc, 'faceReshape')?.opacity).toBe(0.5);
  });

  it('treats a switched-off transform as none for crop geometry, and switches it on to edit it', async () => {
    await open('wide.png', 400, 200);
    store.rotate(1);
    store.flip('horizontal');
    expect(store.orientedSize()).toEqual({ width: 200, height: 400 });
    store.setLayerEnabled('transform', false);
    expect(store.orientedSize()).toEqual({ width: 400, height: 200 });

    store.setCropAspect('1:1');
    const transform = findLayer(store.getState().doc, 'transform')!;
    expect(transform).toMatchObject({ enabled: true, params: { rotate: 0, flipH: false, flipV: false } });
    expect(transform.params.crop!.width * 400).toBeCloseTo(transform.params.crop!.height * 200);
  });

  it('rotates a switched-off transform from what is shown', async () => {
    await open();
    store.rotate(1);
    store.flip('vertical');
    store.setLayerEnabled('transform', false);
    store.rotate(-1);
    expect(findLayer(store.getState().doc, 'transform')).toMatchObject({
      enabled: true,
      params: { rotate: 270, flipH: false, flipV: false, crop: null },
    });
  });
});

describe('filter looks', () => {
  it('applies a newly picked look at full strength and keeps the intensity when re-picking it', async () => {
    await open();
    store.selectLook('mono');
    expect(findLayer(store.getState().doc, 'filter')?.params).toEqual({ lookId: 'mono', intensity: 1 });
    store.setParam('filter', 'intensity', 0.4);
    store.selectLook('mono');
    expect(findLayer(store.getState().doc, 'filter')?.params.intensity).toBe(0.4);
    store.selectLook('film');
    expect(findLayer(store.getState().doc, 'filter')?.params).toEqual({ lookId: 'film', intensity: 1 });
  });

  it('shows a hidden filter layer when a look is picked', async () => {
    await open();
    store.selectLook('warm');
    store.setLayerOpacity('filter', 0);
    store.selectLook('warm');
    expect(findLayer(store.getState().doc, 'filter')).toMatchObject({ enabled: true, opacity: 1 });
  });
});

describe('one-tap presets', () => {
  const film = BUILTIN_PRESETS.find((preset) => preset.name === 'Film')!;
  const refined = BUILTIN_PRESETS.find((preset) => preset.name === 'Refined')!;

  it('keep hand-made reshape and teeth edits they do not set', async () => {
    await open();
    store.setParam('faceReshape', 'slim', 0.3);
    store.setParam('teethWhiten', 'amount', 0.5);
    store.setParam('adjust', 'exposure', 0.5);
    store.applyPreset(film);
    expect(layerKinds()).toEqual(['skinSmooth', 'teethWhiten', 'faceReshape', 'adjust', 'filter', 'vignette', 'grain']);
    expect(findLayer(store.getState().doc, 'faceReshape')?.params.slim).toBe(0.3);
    expect(findLayer(store.getState().doc, 'teethWhiten')?.params.amount).toBe(0.5);
    expect(findLayer(store.getState().doc, 'adjust')?.params.exposure).toBe(0);
  });

  it('replace reshape and teeth edits they set themselves', async () => {
    await open();
    store.setParam('faceReshape', 'chin', 0.3);
    store.applyPreset(refined);
    expect(findLayer(store.getState().doc, 'faceReshape')?.params).toMatchObject({ slim: 0.22, chin: 0 });
  });
});

describe('crop aspect lock and history', () => {
  it('undo and redo restore the aspect lock that went with each step, including after a rotation', async () => {
    await open('portrait.png', 200, 400);
    store.setCropAspect('9:16');
    store.rotate(1);
    expect(store.getState().cropAspect).toBe('16:9');
    store.undo();
    expect(store.getState().cropAspect).toBe('9:16');
    const crop = findLayer(store.getState().doc, 'transform')!.params.crop!;
    expect((crop.width * 200) / (crop.height * 400)).toBeCloseTo(9 / 16);
    store.redo();
    expect(store.getState().cropAspect).toBe('16:9');
    store.undo();
    store.undo();
    expect(store.getState().cropAspect).toBe('free');
  });

  it('resetting the geometry unlocks the aspect, and undo locks it again', async () => {
    await open();
    store.setCropAspect('1:1');
    store.removeLayer('transform');
    expect(store.getState().cropAspect).toBe('free');
    store.undo();
    expect(store.getState().cropAspect).toBe('1:1');
    store.resetAll();
    expect(store.getState().cropAspect).toBe('free');
    store.undo();
    expect(store.getState().cropAspect).toBe('1:1');
  });

  it('changing only the aspect lock is not an undo step', async () => {
    await open();
    store.setParam('adjust', 'contrast', 0.2);
    store.setCropAspect('1:1');
    store.setCropAspect('free');
    expect(store.getState().cropAspect).toBe('free');
    store.undo();
    store.undo();
    expect(store.getState().canUndo).toBe(false);
  });
});

describe('presets with imported LUTs', () => {
  it('drops the filter of a preset whose imported LUT is not loaded, with a localised warning', async () => {
    await open();
    store.setLanguage('zh');
    await store.importPresetFile(
      presetFile([
        { kind: 'adjust', params: { exposure: 0.3 } },
        { kind: 'filter', params: { lookId: 'custom:my-film-0a1b2c3d', intensity: 1 } },
      ]),
    );
    expect(layerKinds()).toEqual(['adjust']);
    expect(store.getState().presetWarnings).toEqual([
      '此预设使用的导入 LUT（「my-film」）在这里没有加载，已跳过该滤镜。',
    ]);
    expect(store.getState().toasts.at(-1)).toMatchObject({ tone: 'info', message: 'presets.warnings' });
  });

  it('names a missing LUT by its id when no file name can be derived', async () => {
    await open();
    await store.importPresetFile(presetFile([{ kind: 'filter', params: { lookId: 'custom:1-invert' } }]));
    expect(store.getState().presetWarnings[0]).toContain('“1-invert”');
  });

  it('finds the LUT again when the same .cube is imported first, even in another session', async () => {
    await open();
    await store.importCubeFile(cubeFile('My Film.cube'));
    const lookId = findLayer(store.getState().doc, 'filter')!.params.lookId;
    expect(lookId).toMatch(/^custom:my-film-[0-9a-f]{8}$/);

    const other = new EditorStore();
    try {
      await other.importCubeFile(cubeFile('My Film.cube', 1));
      expect(other.getState().customLooks[0]!.lookId).not.toBe(lookId);
      await other.importCubeFile(cubeFile('My Film.cube'));
      await other.importCubeFile(cubeFile('My Film.cube'));
      expect(other.getState().customLooks.map((look) => look.lookId)).toEqual([expect.any(String), lookId]);
    } finally {
      other.dispose();
    }

    store.selectLook('warm');
    await store.importPresetFile(presetFile([{ kind: 'filter', params: { lookId, intensity: 0.6 } }]));
    expect(store.getState().presetWarnings).toEqual([]);
    expect(findLayer(store.getState().doc, 'filter')?.params).toEqual({ lookId, intensity: 0.6 });
  });

  it('notes that an imported LUT is not part of an exported preset', async () => {
    const download = vi.fn();
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, click: download, remove: vi.fn() }),
      body: { append: vi.fn() },
    });
    await open();
    store.selectLook('film');
    store.exportPreset('Built-in look');
    expect(store.getState().toasts.map((toast) => toast.message)).toEqual(['presets.saved']);

    await store.importCubeFile(cubeFile('invert.cube'));
    store.exportPreset('Imported look');
    expect(download).toHaveBeenCalledTimes(2);
    expect(store.getState().toasts.slice(-2).map((toast) => toast.message)).toEqual(['presets.saved', 'presets.lutNotShared']);
  });
});

describe('toasts', () => {
  it('wait while paused and get their full time again when resumed', async () => {
    vi.useFakeTimers();
    store.toast('info', 'toast.dismiss');
    const id = store.getState().toasts[0]!.id;
    vi.advanceTimersByTime(3000);
    store.pauseToast(id);
    vi.advanceTimersByTime(60_000);
    expect(store.getState().toasts).toHaveLength(1);
    store.resumeToast(id);
    vi.advanceTimersByTime(3999);
    expect(store.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.getState().toasts).toHaveLength(0);
  });

  it('ignore pause and resume for toasts that are gone', () => {
    vi.useFakeTimers();
    store.toast('success', 'toast.dismiss');
    const id = store.getState().toasts[0]!.id;
    store.dismissToast(id);
    store.resumeToast(id);
    store.pauseToast(id);
    vi.runAllTimers();
    expect(store.getState().toasts).toEqual([]);
  });
});
