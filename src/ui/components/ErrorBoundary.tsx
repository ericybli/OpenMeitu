import { Component, type ContextType, type ReactNode } from 'react';
import { EditorStoreContext } from '../../app/hooks';
import { translate } from '../i18n';
import { AlertIcon } from '../icons';

interface State {
  error: Error | null;
}

/** Last-resort fallback so an unexpected UI error never leaves a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  static override contextType = EditorStoreContext;
  declare context: ContextType<typeof EditorStoreContext>;
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const language = this.context?.getState().language ?? 'en';
    return (
      <main className="crash" role="alert">
        <AlertIcon size={32} />
        <h1>{translate(language, 'crash.title')}</h1>
        <p>{translate(language, 'crash.hint')}</p>
        <p className="crash__detail">{error.message}</p>
        <button type="button" className="button button--primary" onClick={() => window.location.reload()}>
          {translate(language, 'crash.reload')}
        </button>
      </main>
    );
  }
}
