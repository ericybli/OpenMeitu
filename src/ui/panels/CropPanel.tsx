import { useRef, type ReactNode } from 'react';
import { useEditor, useStore, useT } from '../../app/hooks';
import { CROP_ASPECTS, type CropAspect } from '../../app/crop';
import { findLayer } from '../../app/store';
import { useCropHint } from '../components/CropOverlay';
import { PanelSection } from '../components/PanelSection';
import { useFocusHandoffOnDisable } from '../focus';
import { FlipHorizontalIcon, FlipVerticalIcon, ResetIcon, RotateLeftIcon, RotateRightIcon } from '../icons';

/** Small proportional rectangle illustrating an aspect ratio. */
function AspectGlyph({ aspect }: { aspect: CropAspect }) {
  if (aspect === 'free' || aspect === 'original') {
    return <span className={`aspect-glyph aspect-glyph--${aspect}`} aria-hidden="true" />;
  }
  const [w, h] = aspect.split(':').map(Number) as [number, number];
  const scale = 16 / Math.max(w, h);
  return <span className="aspect-glyph" style={{ width: w * scale, height: h * scale }} aria-hidden="true" />;
}

function ToolButton({ label, onClick, testId, children }: { label: string; onClick: () => void; testId: string; children: ReactNode }) {
  return (
    <button type="button" className="tool-button" onClick={onClick} data-testid={testId} title={label}>
      {children}
      <span>{label}</span>
    </button>
  );
}

export function CropPanel() {
  const store = useStore();
  const t = useT();
  const hint = useCropHint();
  const aspect = useEditor((s) => s.cropAspect);
  // Subscribing to the transform layer also re-renders when the output size changes.
  const transform = useEditor((s) => findLayer(s.doc, 'transform'));
  const output = store.measureOutput();
  const aspectGridRef = useRef<HTMLDivElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  // After resetting, keyboard focus moves to the (now "Free") selected aspect.
  useFocusHandoffOnDisable(resetRef, !transform, () =>
    aspectGridRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]'),
  );

  return (
    <>
      <PanelSection title={t('crop.geometry')}>
        <div className="tool-button-grid">
          <ToolButton label={t('crop.rotateLeft')} onClick={() => store.rotate(-1)} testId="crop-rotate-left">
            <RotateLeftIcon />
          </ToolButton>
          <ToolButton label={t('crop.rotateRight')} onClick={() => store.rotate(1)} testId="crop-rotate-right">
            <RotateRightIcon />
          </ToolButton>
          <ToolButton label={t('crop.flipH')} onClick={() => store.flip('horizontal')} testId="crop-flip-h">
            <FlipHorizontalIcon />
          </ToolButton>
          <ToolButton label={t('crop.flipV')} onClick={() => store.flip('vertical')} testId="crop-flip-v">
            <FlipVerticalIcon />
          </ToolButton>
        </div>
      </PanelSection>
      <PanelSection title={t('crop.aspect')}>
        <div className="aspect-grid" ref={aspectGridRef} role="group" aria-label={t('crop.aspect')}>
          {CROP_ASPECTS.map((id) => (
            <button
              key={id}
              type="button"
              className="aspect-option"
              aria-pressed={aspect === id}
              onClick={() => store.setCropAspect(id)}
              data-testid={`crop-aspect-${id}`}
            >
              <AspectGlyph aspect={id} />
              <span>{id === 'free' ? t('crop.aspect.free') : id === 'original' ? t('crop.aspect.original') : id}</span>
            </button>
          ))}
        </div>
        <p className="panel-hint">{hint}</p>
      </PanelSection>
      <PanelSection>
        {output && (
          <p className="panel-meta" data-testid="crop-output-size">
            {t('crop.size', { width: output.width, height: output.height })}
          </p>
        )}
        <button
          ref={resetRef}
          type="button"
          className="button button--ghost button--block"
          onClick={() => store.removeLayer('transform')}
          disabled={!transform}
          data-testid="crop-reset"
        >
          <ResetIcon size={18} />
          <span>{t('crop.reset')}</span>
        </button>
      </PanelSection>
    </>
  );
}
