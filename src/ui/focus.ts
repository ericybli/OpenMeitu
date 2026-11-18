import { useLayoutEffect, type RefObject } from 'react';

/**
 * A focused button that becomes disabled silently drops keyboard focus to
 * <body>. Browsers only fix focus up after rendering, so a layout effect still
 * sees the button focused and can hand focus to `next()` instead.
 */
export function useFocusHandoffOnDisable(
  button: RefObject<HTMLButtonElement | null>,
  disabled: boolean,
  next: () => HTMLElement | null | undefined,
): void {
  useLayoutEffect(() => {
    if (disabled && button.current !== null && button.current === document.activeElement) next()?.focus();
  }, [button, disabled, next]);
}

/**
 * Calls `onRemoved` when the component unmounts while keyboard focus is inside
 * `element`. React runs layout cleanups before it detaches the DOM, so focus is
 * still there and can be passed on before the browser drops it to <body>.
 * `onRemoved` must be stable (e.g. from useCallback): the check also runs when it changes.
 */
export function useFocusLossOnUnmount(
  element: RefObject<HTMLElement | null>,
  onRemoved: (node: HTMLElement) => void,
): void {
  useLayoutEffect(() => {
    const node = element.current;
    return () => {
      if (node?.contains(document.activeElement)) onRemoved(node);
    };
  }, [element, onRemoved]);
}
