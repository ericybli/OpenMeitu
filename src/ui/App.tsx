import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ComponentType } from 'react';
import { EditorStoreContext, useEditor, useStore, useT } from '../app/hooks';
import { pickFile } from '../app/io';
import { EditorStore, type ToolId } from '../app/store';
import { CanvasView } from './components/CanvasView';
import { EditsPanel } from './components/EditsPanel';
import { EmptyState } from './components/EmptyState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header } from './components/Header';
import { Toasts } from './components/Toasts';
import { TOOL_META, ToolRail } from './components/ToolRail';
import { UploadIcon } from './icons';
import { AdjustPanel } from './panels/AdjustPanel';
import { BeautyPanel } from './panels/BeautyPanel';
import { CropPanel } from './panels/CropPanel';
import { EffectsPanel } from './panels/EffectsPanel';
import { FiltersPanel } from './panels/FiltersPanel';
import { PresetsPanel } from './panels/PresetsPanel';

const PANELS: { readonly [T in ToolId]: ComponentType } = {
  beauty: BeautyPanel,
  adjust: AdjustPanel,
  filters: FiltersPanel,
  effects: EffectsPanel,
  crop: CropPanel,
  presets: PresetsPanel,
};

export function App() {
  const [store] = useState(() => new EditorStore());
  useEffect(() => () => store.dispose(), [store]);
  return (
    <EditorStoreContext value={store}>
      <ErrorBoundary>
        <Shell />
      </ErrorBoundary>
    </EditorStoreContext>
  );
}

function Shell() {
  const store = useStore();
  const hasImage = useEditor((s) => s.image !== null);
  const fileName = useEditor((s) => s.fileName);
  const fileInput = useRef<HTMLInputElement>(null);
  const openPicker = useCallback(() => fileInput.current?.click(), []);
  const openFile = useCallback((file: File) => void store.openFile(file), [store]);
  const dragging = useFileDrop(openFile);

  useEditorShortcuts(openPicker);
  useClipboardImages(openFile);

  useEffect(() => {
    document.title = fileName ? `${fileName} · OpenMeitu` : 'OpenMeitu';
  }, [fileName]);

  const onFileChosen = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    // Reset so picking the same file again still fires a change event.
    e.currentTarget.value = '';
    if (file) openFile(file);
  };

  return (
    <div className="app">
      <Header onOpen={openPicker} />
      {hasImage ? <Editor /> : <EmptyState onOpen={openPicker} />}
      <input
        ref={fileInput}
        type="file"
        accept="image/*,.heic,.heif"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFileChosen}
        data-testid="file-input"
      />
      {dragging && <DropOverlay />}
      <Toasts />
    </div>
  );
}

function Editor() {
  const t = useT();
  const tool = useEditor((s) => s.tool);
  const imageId = useEditor((s) => s.imageId);
  const Panel = PANELS[tool];
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Opening a photo replaces the drop zone that had focus: continue from the tool panel instead of <body>.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus({ preventScroll: true });
  }, [imageId]);

  return (
    <main className="editor" data-testid="editor">
      <ToolRail />
      <section className="panel" aria-label={t(TOOL_META[tool].label)} data-testid={`panel-${tool}`}>
        <h2 className="panel__title" ref={headingRef} tabIndex={-1}>
          {t(TOOL_META[tool].label)}
        </h2>
        <div className="panel__body">
          <Panel />
        </div>
      </section>
      <CanvasView />
      <aside className="edits-panel" aria-label={t('edits.title')}>
        <EditsPanel />
      </aside>
    </main>
  );
}

function DropOverlay() {
  const t = useT();
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-overlay__card">
        <UploadIcon size={36} />
        <span>{t('empty.dropOverlay')}</span>
      </div>
    </div>
  );
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit', 'file'].includes(target.type);
}

/** Elements where Space has its own meaning (typing, activating buttons, toggles, links, file pickers). */
function ownsSpace(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return target.type !== 'range';
  if (isTextEntry(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('button, a[href], summary, [role="switch"], [role="radio"]') !== null;
}

/** Undo/redo/open shortcuts and hold-Space-to-compare. */
function useEditorShortcuts(openPicker: () => void) {
  const store = useStore();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'o') {
          e.preventDefault();
          openPicker();
          return;
        }
        if (isTextEntry(e.target)) return;
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) store.redo();
          else store.undo();
        } else if (key === 'y') {
          e.preventDefault();
          store.redo();
        }
        return;
      }
      if (e.code === 'Space' && !mod && store.getState().image && !ownsSpace(e.target)) {
        e.preventDefault();
        if (!e.repeat) store.setCompare(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && store.getState().compare && !ownsSpace(e.target)) {
        e.preventDefault();
        store.setCompare(false);
      }
    };
    const onBlur = () => store.setCompare(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [store, openPicker]);
}

/** Opens images pasted anywhere on the page (except into text fields). */
function useClipboardImages(onFile: (file: File) => void) {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTextEntry(e.target)) return;
      const file = pickFile(e.clipboardData?.files);
      if (!file) return;
      e.preventDefault();
      onFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onFile]);
}

/** Window-wide drag & drop of files; returns whether files are being dragged over the page. */
function useFileDrop(onFile: (file: File) => void): boolean {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = pickFile(e.dataTransfer?.files);
      if (file) onFile(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFile]);

  return dragging;
}
