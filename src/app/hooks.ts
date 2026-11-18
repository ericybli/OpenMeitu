import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { translate, type MessageKey, type MessageParams } from '../ui/i18n';
import type { EditorState, EditorStore } from './store';

export const EditorStoreContext = createContext<EditorStore | null>(null);

export function useStore(): EditorStore {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error('useStore must be used inside <EditorStoreContext>');
  return store;
}

/**
 * Subscribe to a slice of editor state. The selector must return a value
 * that is stable between unrelated updates (a primitive or an object taken
 * from the state as-is).
 */
export function useEditor<T>(selector: (state: EditorState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Translator bound to the current UI language. */
export function useT(): Translate {
  const language = useEditor((s) => s.language);
  return useCallback((key: MessageKey, params?: MessageParams) => translate(language, key, params), [language]);
}
