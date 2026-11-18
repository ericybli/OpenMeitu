import { useEffect, useRef, useState } from 'react';
import { useEditor, useStore, useT } from '../../app/hooks';
import { errorMessage } from '../../app/io';
import type { EditorState } from '../../app/store';
import { Renderer } from '../../engine/renderer';
import type { AnyLayer } from '../../engine/types';
import { AlertIcon } from '../icons';
import { CropOverlay } from './CropOverlay';

/** Everything a preview frame depends on; a frame is skipped when none of it changed. */
interface FrameInputs {
  layers: readonly AnyLayer[];
  cropping: boolean;
  compare: boolean;
  face: EditorState['face'];
  imageId: number;
  customLooks: EditorState['customLooks'];
  width: number;
  height: number;
  dpr: number;
}

/** True when two layer stacks differ at most in the crop rectangle (which the crop view does not render). */
function sameIgnoringCrop(a: readonly AnyLayer[], b: readonly AnyLayer[]): boolean {
  return (
    a.length === b.length &&
    a.every((layer, i) => {
      const other = b[i]!;
      if (layer === other) return true;
      if (layer.kind !== 'transform' || other.kind !== 'transform') return false;
      const p = layer.params;
      const q = other.params;
      return (
        layer.enabled === other.enabled &&
        layer.opacity === other.opacity &&
        p.rotate === q.rotate &&
        p.flipH === q.flipH &&
        p.flipV === q.flipV
      );
    })
  );
}

function sameFrame(a: FrameInputs | null, b: FrameInputs): boolean {
  if (!a) return false;
  return (Object.keys(b) as (keyof FrameInputs)[]).every((key) =>
    key === 'layers' && b.cropping ? sameIgnoringCrop(a.layers, b.layers) : a[key] === b[key],
  );
}

/** While cropping, show the whole (rotated/flipped) image so the frame can be adjusted. */
function previewLayers(layers: readonly AnyLayer[], cropping: boolean): readonly AnyLayer[] {
  if (!cropping) return layers;
  return layers.map((layer) =>
    layer.kind === 'transform' && layer.params.crop ? { ...layer, params: { ...layer.params, crop: null } } : layer,
  );
}

/**
 * The photo preview. Owns the main WebGL Renderer, fits the output into the
 * available space (device-pixel exact) and redraws at most once per frame.
 */
export function CanvasView() {
  const store = useStore();
  const t = useT();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const cropping = useEditor((s) => s.tool === 'crop');
  const compare = useEditor((s) => s.compare);

  useEffect(() => {
    const workspace = workspaceRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!workspace || !stage || !canvas) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer(canvas);
    } catch (error) {
      setGlError(errorMessage(error));
      return;
    }
    store.attachRenderer(renderer);

    let box = { width: 0, height: 0 };
    let frame = 0;
    let last: FrameInputs | null = null;
    let failing = false;
    let contextLost = false;

    const draw = () => {
      frame = 0;
      const s = store.getState();
      if (contextLost || !s.image || box.width < 1 || box.height < 1) return;
      const inputs: FrameInputs = {
        layers: s.doc.layers,
        cropping: s.tool === 'crop',
        compare: s.compare,
        face: s.face,
        imageId: s.imageId,
        customLooks: s.customLooks,
        width: box.width,
        height: box.height,
        dpr: window.devicePixelRatio || 1,
      };
      if (sameFrame(last, inputs)) return;
      last = inputs;
      try {
        const layers = previewLayers(inputs.layers, inputs.cropping);
        const full = renderer.measureOutput(layers);
        const fit = Math.min(box.width / full.width, box.height / full.height);
        const cssWidth = Math.max(1, Math.floor(full.width * fit));
        const cssHeight = Math.max(1, Math.floor(full.height * fit));
        stage.style.width = `${cssWidth}px`;
        stage.style.height = `${cssHeight}px`;
        renderer.renderPreview(layers, {
          width: Math.round(cssWidth * inputs.dpr),
          height: Math.round(cssHeight * inputs.dpr),
          showOriginal: inputs.compare,
        });
        failing = false;
      } catch (error) {
        // Report once per failure streak, not on every frame.
        if (!failing) store.reportRenderError(errorMessage(error));
        failing = true;
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    // Browsers drop GPU contexts on driver resets or when a mobile tab is backgrounded.
    // Cancelling the default lets them restore it; the renderer is then rebuilt from the store.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      store.detachRenderer(renderer);
      store.toast('info', 'toast.contextLost');
    };
    const onContextRestored = () => {
      try {
        renderer = new Renderer(canvas);
      } catch (error) {
        setGlError(errorMessage(error));
        return;
      }
      contextLost = false;
      store.attachRenderer(renderer);
      last = null;
      schedule();
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      box = { width: rect.width, height: rect.height };
      schedule();
    });
    observer.observe(workspace);
    const unsubscribe = store.subscribe(schedule);
    schedule();

    return () => {
      unsubscribe();
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      cancelAnimationFrame(frame);
      store.detachRenderer(renderer);
      renderer.dispose();
    };
  }, [store]);

  return (
    <div className="workspace" ref={workspaceRef}>
      {glError ? (
        <div className="workspace__error" role="alert" data-testid="webgl-error">
          <AlertIcon size={28} />
          <h2>{t('canvas.webglTitle')}</h2>
          <p>{t('canvas.webglHint')}</p>
          <p className="workspace__error-detail">{glError}</p>
        </div>
      ) : null}
      <div className="stage" ref={stageRef} data-testid="canvas-stage" hidden={glError !== null}>
        <canvas ref={canvasRef} className="stage__canvas" role="img" aria-label={t('canvas.label')} data-testid="editor-canvas" />
        {cropping && <CropOverlay concealed={compare} />}
        {compare && <span className="stage__badge">{t('canvas.original')}</span>}
      </div>
    </div>
  );
}
