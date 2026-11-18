import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { useEditor, useStore, useT } from '../../app/hooks';
import type { Toast } from '../../app/store';
import { AlertIcon, CheckIcon, CloseIcon } from '../icons';

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]';

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);

  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

/**
 * A toast waits to auto-dismiss while it is hovered or holds focus. If it goes
 * away while focused, focus returns to where it came from instead of <body>.
 */
function ToastItem({ toast }: { toast: Toast }) {
  const store = useStore();
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const held = hovered || focused;

  useEffect(() => {
    if (!held) return;
    store.pauseToast(toast.id);
    return () => store.resumeToast(toast.id);
  }, [held, store, toast.id]);

  // Layout cleanup runs while the toast is still in the document, before focus would fall to <body>.
  // It checks the active element rather than `focused`: when the window loses focus the toast's
  // countdown resumes, but its button stays the element that gets focus back.
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (node?.contains(document.activeElement)) restoreFocus(returnFocus.current, node);
    };
  }, []);

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    // No related target when the window regains focus: keep the element focus came from before.
    const from = e.relatedTarget;
    if (from instanceof HTMLElement && !e.currentTarget.contains(from)) returnFocus.current = from;
    setFocused(true);
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
  };

  return (
    <div
      ref={ref}
      className={`toast toast--${toast.tone}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={onFocus}
      onBlur={onBlur}
      data-testid="toast"
      data-tone={toast.tone}
    >
      {toast.tone === 'success' ? <CheckIcon size={18} /> : <AlertIcon size={18} />}
      <span className="toast__message">{t(toast.message, toast.params)}</span>
      <button
        type="button"
        className="icon-button icon-button--small"
        onClick={() => store.dismissToast(toast.id)}
        aria-label={t('toast.dismiss')}
        data-testid="toast-dismiss"
      >
        <CloseIcon size={16} />
      </button>
    </div>
  );
}

/** Focus `target` if it can still take focus, else the first focusable control outside the departing toast. */
function restoreFocus(target: HTMLElement | null, toast: HTMLElement): void {
  if (target?.isConnected && !toast.contains(target)) {
    target.focus();
    if (document.activeElement === target) return;
  }
  for (const candidate of document.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (toast.contains(candidate) || candidate.tabIndex < 0) continue;
    candidate.focus();
    if (document.activeElement === candidate) return;
  }
}
