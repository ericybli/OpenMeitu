import { useEditor, useT } from '../../app/hooks';
import { shortcutLabel } from '../../app/io';
import { BeautyIcon, CropIcon, FiltersIcon, LockIcon, UploadIcon } from '../icons';

/** Landing view: a large drop zone that also opens the file picker. */
export function EmptyState({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const loading = useEditor((s) => s.loading);

  return (
    <main className="empty">
      <button type="button" className="dropzone" onClick={onOpen} disabled={loading} data-testid="drop-zone">
        <span className="dropzone__icon" aria-hidden="true">
          {loading ? <span className="spinner spinner--large" /> : <UploadIcon size={32} />}
        </span>
        <span className="dropzone__title">{loading ? t('app.loading') : t('empty.title')}</span>
        <span className="dropzone__hint">{t('empty.hint', { shortcut: shortcutLabel('V') })}</span>
        <span className="button button--primary dropzone__cta">{t('empty.choose')}</span>
        <span className="dropzone__formats">{t('empty.formats')}</span>
      </button>
      <ul className="empty__features">
        <li>
          <BeautyIcon size={18} />
          {t('empty.featureBeauty')}
        </li>
        <li>
          <FiltersIcon size={18} />
          {t('empty.featureColor')}
        </li>
        <li>
          <CropIcon size={18} />
          {t('empty.featureCrop')}
        </li>
      </ul>
      <p className="empty__privacy" data-testid="privacy-tagline">
        <LockIcon size={16} />
        {t('app.tagline')}
      </p>
    </main>
  );
}
