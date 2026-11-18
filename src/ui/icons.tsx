import { useId, type ReactNode, type SVGProps } from 'react';

/** Stroke icons drawn for OpenMeitu on a 24px grid. They inherit `currentColor`. */

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function icon(paths: ReactNode) {
  return function Icon({ size = 20, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

export const OpenIcon = icon(
  <>
    <path d="M13 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V11" />
    <path d="M4 16.5l4.4-4.4a1.5 1.5 0 0 1 2.1 0L16 17.6" />
    <path d="M14 15.5l1.4-1.4a1.5 1.5 0 0 1 2.1 0l2.5 2.5" />
    <path d="M18 2.5v6M15 5.5h6" />
  </>,
);

export const UndoIcon = icon(
  <>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </>,
);

export const RedoIcon = icon(
  <>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </>,
);

export const CompareIcon = icon(
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M12 2.5v19" />
    <path d="M12 4.5h6.5A2.5 2.5 0 0 1 21 7v10a2.5 2.5 0 0 1-2.5 2.5H12z" fill="currentColor" fillOpacity={0.28} stroke="none" />
  </>,
);

export const DownloadIcon = icon(
  <>
    <path d="M12 4v11" />
    <path d="M7.5 10.5L12 15l4.5-4.5" />
    <path d="M5 19.5h14" />
  </>,
);

export const CodeIcon = icon(
  <>
    <path d="M8.5 7.5L4 12l4.5 4.5" />
    <path d="M15.5 7.5L20 12l-4.5 4.5" />
    <path d="M13.5 5l-3 14" />
  </>,
);

export const BeautyIcon = icon(
  <>
    <path d="M10 3.5l1.6 4.4a2 2 0 0 0 1.2 1.2L17.2 10.7l-4.4 1.6a2 2 0 0 0-1.2 1.2L10 17.9l-1.6-4.4a2 2 0 0 0-1.2-1.2L2.8 10.7l4.4-1.6a2 2 0 0 0 1.2-1.2z" />
    <path d="M18 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    <path d="M18.5 3v3M17 4.5h3" />
  </>,
);

export const AdjustIcon = icon(
  <>
    <path d="M4 6.5h8.5M16.5 6.5H20M4 12h2.5M10.5 12H20M4 17.5h10M18 17.5h2" />
    <circle cx="14.5" cy="6.5" r="2" />
    <circle cx="8.5" cy="12" r="2" />
    <circle cx="16" cy="17.5" r="2" />
  </>,
);

export const FiltersIcon = icon(
  <>
    <circle cx="9" cy="9.5" r="5" />
    <circle cx="15" cy="9.5" r="5" />
    <circle cx="12" cy="14.5" r="5" />
  </>,
);

export const EffectsIcon = icon(
  <>
    <path d="M4.5 19.5L14 10" />
    <path d="M12.5 8.5l3 3" />
    <path d="M17 3.5v2.5M15.75 4.75h2.5" />
    <path d="M19.5 9.5v2M18.5 10.5h2" />
    <path d="M10 3.5v2M9 4.5h2" />
  </>,
);

export const CropIcon = icon(
  <>
    <path d="M6.5 2.5v13a2 2 0 0 0 2 2h13" />
    <path d="M2.5 6.5h13a2 2 0 0 1 2 2v13" />
  </>,
);

export const PresetsIcon = icon(
  <>
    <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z" />
    <path d="M3.5 12l8.5 4.5 8.5-4.5" />
    <path d="M3.5 16l8.5 4.5 8.5-4.5" />
  </>,
);

export const RotateLeftIcon = icon(
  <>
    <path d="M4.5 4v4.5H9" />
    <path d="M4.9 8.5A8 8 0 1 1 4.5 15" />
  </>,
);

export const RotateRightIcon = icon(
  <>
    <path d="M19.5 4v4.5H15" />
    <path d="M19.1 8.5A8 8 0 1 0 19.5 15" />
  </>,
);

export const FlipHorizontalIcon = icon(
  <>
    <path d="M12 3v2M12 9v2M12 15v2M12 19v2" />
    <path d="M9 7L3.5 17H9z" />
    <path d="M15 7l5.5 10H15z" fill="currentColor" fillOpacity={0.28} />
  </>,
);

export const FlipVerticalIcon = icon(
  <>
    <path d="M3 12h2M9 12h2M15 12h2M19 12h2" />
    <path d="M7 9L17 3.5V9z" />
    <path d="M7 15l10 5.5V15z" fill="currentColor" fillOpacity={0.28} />
  </>,
);

export const ResetIcon = icon(
  <>
    <path d="M4 4.5v4.5h4.5" />
    <path d="M4.6 9A7.5 7.5 0 1 1 4.5 14" />
  </>,
);

export const TrashIcon = icon(
  <>
    <path d="M4.5 7h15" />
    <path d="M10 11v5.5M14 11v5.5" />
    <path d="M6.5 7l.8 11.6a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" />
    <path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2" />
  </>,
);

export const FaceIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9 10v.5M15 10v.5" />
    <path d="M9 14.5c1.6 1.4 4.4 1.4 6 0" />
  </>,
);

export const LockIcon = icon(
  <>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </>,
);

export const UploadIcon = icon(
  <>
    <path d="M12 15.5V4" />
    <path d="M7.5 8.5L12 4l4.5 4.5" />
    <path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
  </>,
);

export const CloseIcon = icon(<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);

export const CheckIcon = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />);

export const ChevronDownIcon = icon(<path d="M6.5 9.5L12 15l5.5-5.5" />);

export const FileExportIcon = icon(
  <>
    <path d="M13.5 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
    <path d="M13.5 3.5V9H19" />
    <path d="M12 12.5v5M9.5 15l2.5 2.5 2.5-2.5" />
  </>,
);

export const FileImportIcon = icon(
  <>
    <path d="M13.5 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
    <path d="M13.5 3.5V9H19" />
    <path d="M12 17.5v-5M9.5 15l2.5-2.5 2.5 2.5" />
  </>,
);

export const CubeIcon = icon(
  <>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
  </>,
);

export const AlertIcon = icon(
  <>
    <path d="M10.3 4.2L2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4M12 17v.01" />
  </>,
);

export const LayersIcon = icon(
  <>
    <rect x="4" y="4" width="11" height="11" rx="2" />
    <path d="M9 19.5h8.5a2 2 0 0 0 2-2V9" />
  </>,
);

/** OpenMeitu mark: a lens ring with a spark, on a warm tile. */
export function LogoMark({ size = 28 }: { size?: number }) {
  const gradientId = `om-logo-${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb86b" />
          <stop offset="1" stopColor="#ff6b3d" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      <circle cx="14.5" cy="17.5" r="7" fill="none" stroke="#fff" strokeWidth="3.2" />
      <path d="M23.5 4.8l1.25 3.2 3.2 1.25-3.2 1.25-1.25 3.2-1.25-3.2-3.2-1.25 3.2-1.25z" fill="#fff" />
    </svg>
  );
}
