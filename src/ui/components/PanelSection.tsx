import type { ReactNode } from 'react';

export function PanelSection({ title, aside, children }: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel-section">
      {(title || aside) && (
        <header className="panel-section__head">
          {title && <h3 className="panel-section__title">{title}</h3>}
          {aside}
        </header>
      )}
      <div className="panel-section__body">{children}</div>
    </section>
  );
}
