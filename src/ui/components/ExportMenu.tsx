import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useEditor, useStore, useT } from '../../app/hooks';
import type { ExportFormat } from '../../app/io';
import { ChevronDownIcon, DownloadIcon } from '../icons';
import { formatPercent, Slider } from './Slider';

const DEFAULT_QUALITY = 0.92;
const FORMATS: readonly ExportFormat[] = ['jpeg', 'png'];
const ARROW_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

/** Header button with a popover to pick format/quality and download the full-resolution result. */
export function ExportMenu() {
  const store = useStore();
  const t = useT();
  const hasImage = useEditor((s) => s.image !== null);
  const exporting = useEditor((s) => s.exporting);
  // Re-render when the edit (and thus the output size) changes while open.
  useEditor((s) => s.doc);
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('jpeg');
  const [quality, setQuality] = useState(DEFAULT_QUALITY);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  /**
   * Close the popover. Focus that was inside it, or that fell to <body> (Download disables itself
   * while exporting), goes back to the trigger.
   */
  const close = useCallback(() => {
    setOpen(false);
    const active = document.activeElement;
    if (!active || active === document.body || rootRef.current?.contains(active)) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Tabbing out of the menu closes it, so it never covers the control that receives focus.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };

  /** Arrow keys move the checked format, as in a native radio group. */
  const onFormatKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEPS[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const index = (FORMATS.indexOf(format) + step + FORMATS.length) % FORMATS.length;
    setFormat(FORMATS[index]!);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[index]?.focus();
  };

  const size = open ? store.measureOutput() : null;

  return (
    <div className="export" ref={rootRef} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className="button button--primary"
        disabled={!hasImage}
        aria-label={t('header.export')}
        title={t('header.export')}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((v) => !v)}
        data-testid="export-button"
      >
        <DownloadIcon size={18} />
        <span className="button__label">{t('header.export')}</span>
        <ChevronDownIcon size={16} className="button__chevron" />
      </button>
      {open && hasImage && (
        <div className="popover" id={popoverId} role="dialog" aria-label={t('export.title')} data-testid="export-menu">
          <p className="popover__title">{t('export.title')}</p>
          <div className="field">
            <span className="field__label">{t('export.format')}</span>
            <div className="segmented" role="radiogroup" aria-label={t('export.format')} onKeyDown={onFormatKeyDown}>
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={format === f}
                  tabIndex={format === f ? 0 : -1}
                  className="segmented__option"
                  onClick={() => setFormat(f)}
                  data-testid={`export-format-${f}`}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {format === 'jpeg' ? (
            <Slider
              label={t('export.quality')}
              value={quality}
              min={0.5}
              max={1}
              step={0.01}
              defaultValue={DEFAULT_QUALITY}
              format={(v) => `${formatPercent(v)}%`}
              resetHint={t('slider.resetTitle')}
              onChange={setQuality}
              onReset={() => setQuality(DEFAULT_QUALITY)}
              testId="export-quality"
            />
          ) : (
            <p className="panel-hint">{t('export.pngHint')}</p>
          )}
          {size && <p className="panel-meta">{t('export.size', { width: size.width, height: size.height })}</p>}
          <button
            type="button"
            className="button button--primary button--block"
            disabled={exporting}
            onClick={() => void store.exportImage(format, quality).then(close)}
            data-testid="export-download"
          >
            {exporting ? <span className="spinner" aria-hidden="true" /> : <DownloadIcon size={18} />}
            <span>{exporting ? t('export.working') : t('export.download')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
