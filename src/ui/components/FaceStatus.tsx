import { useEditor, useT } from '../../app/hooks';
import type { FaceStatus as Status } from '../../app/store';
import type { MessageKey } from '../i18n';
import { AlertIcon, FaceIcon } from '../icons';

const LABELS: { readonly [S in Status]: MessageKey } = {
  idle: 'face.idle',
  detecting: 'face.detecting',
  found: 'face.found',
  none: 'face.none',
  error: 'face.error',
};

/** Small status pill showing whether face tools are available. */
export function FaceStatusBadge() {
  const t = useT();
  const status = useEditor((s) => s.faceStatus);
  const count = useEditor((s) => s.face?.faces.length ?? 0);
  const error = useEditor((s) => s.faceError);
  const label = status === 'found' && count > 1 ? t('face.foundMany', { count }) : t(LABELS[status]);

  return (
    <span
      className={`face-status face-status--${status}`}
      data-testid="face-status"
      data-status={status}
      role="status"
      title={status === 'error' && error ? error : undefined}
    >
      {status === 'detecting' ? (
        <span className="spinner" aria-hidden="true" />
      ) : status === 'error' || status === 'none' ? (
        <AlertIcon size={14} />
      ) : (
        <FaceIcon size={14} />
      )}
      <span>{label}</span>
    </span>
  );
}

/** Why face-dependent tools are disabled, or null when they are usable. */
export function useFaceToolsHint(): string | null {
  const t = useT();
  const status = useEditor((s) => s.faceStatus);
  const error = useEditor((s) => s.faceError);
  switch (status) {
    case 'found':
      return null;
    case 'error':
      return t('face.toolsOffError', { detail: error ?? t('face.error') });
    case 'none':
      return t('face.toolsOffNone');
    default:
      return t('face.toolsOffDetecting');
  }
}
