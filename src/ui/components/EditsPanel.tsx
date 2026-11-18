import { useCallback, useLayoutEffect, useRef } from 'react';
import { useEditor, useStore, useT } from '../../app/hooks';
import type { CustomLook } from '../../app/store';
import { FACE_DEPENDENT_KINDS, type AnyLayer, type LayerKind } from '../../engine/types';
import { getLook } from '../../filters/looks';
import { useFocusLossOnUnmount } from '../focus';
import type { Language, MessageKey } from '../i18n';
import { LayersIcon, ResetIcon, TrashIcon } from '../icons';
import { formatPercent, Slider } from './Slider';

const LAYER_NAMES: { readonly [K in LayerKind]: MessageKey } = {
  skinSmooth: 'layer.skinSmooth',
  skinWhiten: 'layer.skinWhiten',
  teethWhiten: 'layer.teethWhiten',
  faceReshape: 'layer.faceReshape',
  adjust: 'layer.adjust',
  filter: 'layer.filter',
  sharpen: 'layer.sharpen',
  vignette: 'layer.vignette',
  grain: 'layer.grain',
  transform: 'layer.transform',
};

export function EditsPanel() {
  const t = useT();
  const layers = useEditor((s) => s.doc.layers);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Position (top to bottom) of a row removed while it held keyboard focus. */
  const focusLostAt = useRef<number | null>(null);
  const onRowRemoved = useCallback((row: HTMLElement) => {
    focusLostAt.current = Array.from(row.parentElement?.children ?? []).indexOf(row);
  }, []);
  const onResetAllRemoved = useCallback(() => {
    focusLostAt.current = 0;
  }, []);

  // Whatever removed it (its own button, Reset all, Undo, a preset), focus moves to the row now in
  // its place, or the one above, or the heading once the list is empty, instead of <body>.
  useLayoutEffect(() => {
    const index = focusLostAt.current;
    if (index === null) return;
    focusLostAt.current = null;
    const rows = listRef.current?.children;
    const row = rows?.[Math.min(index, rows.length - 1)];
    (row?.querySelector<HTMLElement>('[role="switch"]') ?? headingRef.current)?.focus();
  }, [layers]);

  return (
    <div className="edits">
      <header className="edits__head">
        <h2 className="edits__title" ref={headingRef} tabIndex={-1}>
          <LayersIcon size={18} />
          <span>{t('edits.title')}</span>
          {layers.length > 0 && <span className="count-badge">{layers.length}</span>}
        </h2>
        {layers.length > 0 && <ResetAllButton onRemovedWithFocus={onResetAllRemoved} />}
      </header>
      {layers.length === 0 ? (
        <div className="edits__empty">
          <p className="edits__empty-title">{t('edits.empty')}</p>
          <p className="panel-hint">{t('edits.emptyHint')}</p>
        </div>
      ) : (
        <ul className="edits__list" ref={listRef} data-testid="edits-list">
          {[...layers].reverse().map((layer) => (
            <EditRow key={layer.id} layer={layer} onRemovedWithFocus={onRowRemoved} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ResetAllButton({ onRemovedWithFocus }: { onRemovedWithFocus: () => void }) {
  const store = useStore();
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  useFocusLossOnUnmount(ref, onRemovedWithFocus);
  return (
    <button
      ref={ref}
      type="button"
      className="text-button"
      onClick={() => store.resetAll()}
      data-testid="edits-reset-all"
    >
      {t('edits.resetAll')}
    </button>
  );
}

function EditRow({ layer, onRemovedWithFocus }: { layer: AnyLayer; onRemovedWithFocus: (row: HTMLElement) => void }) {
  const store = useStore();
  const t = useT();
  const ref = useRef<HTMLLIElement>(null);
  useFocusLossOnUnmount(ref, onRemovedWithFocus);
  const language = useEditor((s) => s.language);
  const customLooks = useEditor((s) => s.customLooks);
  const hasFace = useEditor((s) => s.faceStatus === 'found');
  const name = t(LAYER_NAMES[layer.kind]);
  const detail = layer.kind === 'filter' ? lookName(layer.params.lookId, language, customLooks) : null;
  const skipped = !hasFace && FACE_DEPENDENT_KINDS.includes(layer.kind);

  return (
    <li ref={ref} className={layer.enabled ? 'edit-row' : 'edit-row is-off'} data-testid={`edit-${layer.kind}`}>
      <div className="edit-row__main">
        <button
          type="button"
          role="switch"
          aria-checked={layer.enabled}
          aria-label={t('edits.visible', { name })}
          className="switch"
          onClick={() => store.setLayerEnabled(layer.kind, !layer.enabled)}
          data-testid={`edit-toggle-${layer.kind}`}
        >
          <span className="switch__thumb" />
        </button>
        <span className="edit-row__name">
          {name}
          {detail && <span className="edit-row__detail"> · {detail}</span>}
          {skipped && <span className="tag">{t('edits.skipped')}</span>}
        </span>
        <button
          type="button"
          className="icon-button icon-button--small"
          onClick={() => store.resetLayer(layer.kind)}
          aria-label={t('edits.reset', { name })}
          title={t('edits.reset', { name })}
          data-testid={`edit-reset-${layer.kind}`}
        >
          <ResetIcon size={16} />
        </button>
        <button
          type="button"
          className="icon-button icon-button--small icon-button--danger"
          onClick={() => store.removeLayer(layer.kind)}
          aria-label={t('edits.delete', { name })}
          title={t('edits.delete', { name })}
          data-testid={`edit-delete-${layer.kind}`}
        >
          <TrashIcon size={16} />
        </button>
      </div>
      {layer.kind !== 'transform' && (
        <Slider
          compact
          label={t('edits.opacity')}
          value={layer.opacity}
          min={0}
          max={1}
          step={0.01}
          defaultValue={1}
          format={(v) => `${formatPercent(v)}%`}
          resetHint={t('slider.resetTitle')}
          disabled={!layer.enabled}
          testId={`edit-opacity-${layer.kind}`}
          onChange={(v) => store.setLayerOpacity(layer.kind, v, true)}
          onGestureEnd={() => store.endGesture()}
          onReset={() => store.setLayerOpacity(layer.kind, 1)}
        />
      )}
    </li>
  );
}

function lookName(lookId: string, language: Language, custom: readonly CustomLook[]): string | null {
  const look = getLook(lookId);
  if (look) return look.name[language];
  return custom.find((c) => c.lookId === lookId)?.name ?? null;
}
