import { useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { useEditor, useStore, useT } from '../../app/hooks';
import { shortcutLabel } from '../../app/io';
import { useFocusHandoffOnDisable } from '../focus';
import { CodeIcon, CompareIcon, LogoMark, OpenIcon, RedoIcon, UndoIcon } from '../icons';
import { ExportMenu } from './ExportMenu';

export const REPO_URL = 'https://github.com/ericybli/OpenMeitu';

function HeaderButton({
  ref,
  label,
  title,
  onClick,
  disabled,
  testId,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className="button button--quiet"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      data-testid={testId}
    >
      {children}
      <span className="button__label">{label}</span>
    </button>
  );
}

/** Shows the original while pressed (pointer, Space or Enter). */
function CompareButton() {
  const store = useStore();
  const t = useT();
  const hasImage = useEditor((s) => s.image !== null);
  const compare = useEditor((s) => s.compare);
  const release = () => store.setCompare(false);
  const isHoldKey = (e: KeyboardEvent) => e.key === ' ' || e.key === 'Enter';

  return (
    <button
      type="button"
      className="button button--quiet compare-button"
      disabled={!hasImage}
      aria-pressed={compare}
      aria-label={t('header.compare')}
      title={t('header.compareTitle')}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        store.setCompare(true);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e) => {
        if (!isHoldKey(e)) return;
        e.preventDefault();
        if (!e.repeat) store.setCompare(true);
      }}
      onKeyUp={(e) => {
        if (!isHoldKey(e)) return;
        e.preventDefault();
        release();
      }}
      onBlur={release}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="compare-button"
    >
      <CompareIcon size={18} />
      <span className="button__label">{t('header.compare')}</span>
    </button>
  );
}

export function Header({ onOpen }: { onOpen: () => void }) {
  const store = useStore();
  const t = useT();
  const hasImage = useEditor((s) => s.image !== null);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const language = useEditor((s) => s.language);
  const fileName = useEditor((s) => s.fileName);
  const openRef = useRef<HTMLButtonElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const redoRef = useRef<HTMLButtonElement>(null);
  const undoDisabled = !hasImage || !canUndo;
  const redoDisabled = !hasImage || !canRedo;
  // Undoing to the first step hands focus to Redo (and vice versa), or to Open when neither is left.
  useFocusHandoffOnDisable(undoRef, undoDisabled, () => (redoDisabled ? openRef.current : redoRef.current));
  useFocusHandoffOnDisable(redoRef, redoDisabled, () => (undoDisabled ? openRef.current : undoRef.current));

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <LogoMark size={28} />
        <span className="topbar__name">OpenMeitu</span>
        {fileName && (
          <span className="topbar__file" title={fileName}>
            {fileName}
          </span>
        )}
      </div>
      <div className="topbar__actions">
        <HeaderButton
          ref={openRef}
          label={t('header.open')}
          title={t('header.openTitle', { shortcut: shortcutLabel('O') })}
          onClick={onOpen}
          testId="open-button"
        >
          <OpenIcon size={18} />
        </HeaderButton>
        <span className="topbar__divider" aria-hidden="true" />
        <HeaderButton
          ref={undoRef}
          label={t('header.undo')}
          title={`${t('header.undo')} (${shortcutLabel('Z')})`}
          onClick={() => store.undo()}
          disabled={undoDisabled}
          testId="undo-button"
        >
          <UndoIcon size={18} />
        </HeaderButton>
        <HeaderButton
          ref={redoRef}
          label={t('header.redo')}
          title={`${t('header.redo')} (${shortcutLabel('Z', true)})`}
          onClick={() => store.redo()}
          disabled={redoDisabled}
          testId="redo-button"
        >
          <RedoIcon size={18} />
        </HeaderButton>
        <CompareButton />
      </div>
      <div className="topbar__end">
        <ExportMenu />
        <button
          type="button"
          className="button button--quiet lang-toggle"
          onClick={() => store.setLanguage(language === 'zh' ? 'en' : 'zh')}
          title={t('header.language')}
          lang={language === 'zh' ? 'en' : 'zh-CN'}
          data-testid="lang-toggle"
        >
          {language === 'zh' ? 'EN' : '中文'}
        </button>
        <a
          className="button button--quiet"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('header.github')}
          title={t('header.github')}
          data-testid="github-link"
        >
          <CodeIcon size={18} />
          <span className="button__label">GitHub</span>
        </a>
      </div>
    </header>
  );
}
