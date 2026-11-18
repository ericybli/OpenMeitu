import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { dragCrop, FULL_RECT, type CropHandle } from '../../app/crop';
import { useEditor, useStore, useT } from '../../app/hooks';
import { isApplePlatform } from '../../app/io';
import { findLayer } from '../../app/store';
import type { CropRect } from '../../engine/types';

const HANDLES: readonly Exclude<CropHandle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Keyboard steps as fractions of the image. */
const MOVE_STEP = 0.005;
const MOVE_STEP_LARGE = 0.05;
const EDGE_STEP = 0.01;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Crop instructions for pointer and keyboard, naming the platform's Alt key. */
export function useCropHint(): string {
  const t = useT();
  return t('crop.hint', { alt: isApplePlatform ? 'Option' : 'Alt' });
}

/**
 * What an arrow key adjusts: plain (or Shift) moves the frame, Alt moves the
 * right/bottom edge and Alt+Shift the left/top edge, in the arrow's direction.
 */
function keyboardHandle(e: KeyboardEvent, horizontal: boolean): CropHandle {
  if (!e.altKey) return 'move';
  if (e.shiftKey) return horizontal ? 'w' : 'n';
  return horizontal ? 'e' : 's';
}

interface Drag {
  pointerId: number;
  handle: CropHandle;
  startX: number;
  startY: number;
  start: CropRect;
  width: number;
  height: number;
}

/**
 * Crop frame drawn over the uncropped preview; coordinates are percentages of the stage.
 * `concealed` hides it while comparing without unmounting, so the frame keeps keyboard focus.
 */
export function CropOverlay({ concealed = false }: { concealed?: boolean }) {
  const store = useStore();
  const t = useT();
  const hint = useCropHint();
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // A switched-off transform layer counts as no transform (as in the store), so show the full frame.
  const rect = useEditor((s) => {
    const layer = findLayer(s.doc, 'transform');
    return layer?.enabled ? layer.params.crop : null;
  }) ?? FULL_RECT;

  const begin = (handle: CropHandle) => (e: PointerEvent<HTMLElement>) => {
    const root = rootRef.current;
    if (!root || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const bounds = root.getBoundingClientRect();
    root.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      start: rect,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
    };
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = (e.clientX - d.startX) / d.width;
    const dy = (e.clientY - d.startY) / d.height;
    store.setCrop(dragCrop(d.start, d.handle, dx, dy, store.cropRatio()), true);
  };

  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    store.endGesture();
  };

  const nudge = (e: KeyboardEvent<HTMLDivElement>) => {
    const direction = ARROWS[e.key];
    if (!direction || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const handle = keyboardHandle(e, direction[0] !== 0);
    const step = handle !== 'move' ? EDGE_STEP : e.shiftKey ? MOVE_STEP_LARGE : MOVE_STEP;
    store.setCrop(dragCrop(rect, handle, direction[0] * step, direction[1] * step, store.cropRatio()), true);
  };

  return (
    <div
      className={concealed ? 'crop crop--concealed' : 'crop'}
      ref={rootRef}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      data-testid="crop-overlay"
    >
      <div className="crop__shade" style={{ left: 0, right: 0, top: 0, height: pct(rect.y) }} />
      <div className="crop__shade" style={{ left: 0, right: 0, bottom: 0, height: pct(1 - rect.y - rect.height) }} />
      <div className="crop__shade" style={{ left: 0, top: pct(rect.y), width: pct(rect.x), height: pct(rect.height) }} />
      <div
        className="crop__shade"
        style={{ right: 0, top: pct(rect.y), width: pct(1 - rect.x - rect.width), height: pct(rect.height) }}
      />
      <div
        className="crop__frame"
        style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.width), height: pct(rect.height) }}
        tabIndex={0}
        role="group"
        aria-label={t('crop.frame')}
        aria-description={hint}
        onPointerDown={begin('move')}
        onKeyDown={nudge}
        onKeyUp={() => store.endGesture()}
        onBlur={() => store.endGesture()}
        data-testid="crop-frame"
      >
        <span className="crop__grid" aria-hidden="true" />
        {HANDLES.map((h) => (
          <span
            key={h}
            className={`crop__handle crop__handle--${h}`}
            onPointerDown={begin(h)}
            aria-hidden="true"
            data-testid={`crop-handle-${h}`}
          />
        ))}
      </div>
    </div>
  );
}

function pct(fraction: number): string {
  return `${Math.max(0, fraction) * 100}%`;
}
