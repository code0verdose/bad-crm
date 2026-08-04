import { type CSSProperties, type ReactNode } from 'react';

/**
 * The page's own small glyphs.
 *
 * No emoji anywhere, and no dingbats standing in for icons either — `🔒`, `✓`, `▸`, `→` all render
 * differently on every platform, take the system emoji font instead of the page's, cannot be
 * coloured or sized with the text around them, and are announced by screen readers as whatever the
 * Unicode name happens to be. These are paths on a 24-unit grid in `currentColor`, like every other
 * mark on the site.
 */
export type IconName = 'check' | 'lock' | 'arrowRight' | 'arrowLeft' | 'caret' | 'server' | 'user';

const ICONS: Record<IconName, ReactNode> = {
  check: <path d="M9.6 16.2 5.4 12l-1.4 1.4 5.6 5.6 12-12-1.4-1.4z" />,
  lock: (
    <path d="M12 1.5A5.5 5.5 0 0 0 6.5 7v2.5h-.8a2 2 0 0 0-2 2v8.2a2 2 0 0 0 2 2h12.6a2 2 0 0 0 2-2v-8.2a2 2 0 0 0-2-2h-.8V7A5.5 5.5 0 0 0 12 1.5zm0 2.2A3.3 3.3 0 0 1 15.3 7v2.5H8.7V7A3.3 3.3 0 0 1 12 3.7zm0 9.6a2 2 0 0 1 1 3.7v1.7a1 1 0 1 1-2 0V17a2 2 0 0 1 1-3.7z" />
  ),
  arrowRight: <path d="M13.2 4.6 11.8 6l5 5H3v2h13.8l-5 5 1.4 1.4 7.4-7.4z" />,
  arrowLeft: <path d="M10.8 19.4 12.2 18l-5-5H21v-2H7.2l5-5-1.4-1.4L3.4 12z" />,
  caret: <path d="M8 5.5 17.5 12 8 18.5z" />,
  user: (
    <path d="M12 12a4.6 4.6 0 1 0 0-9.2A4.6 4.6 0 0 0 12 12zm0 1.9c-4.1 0-7.6 2.4-7.6 5.4v1.3a1 1 0 0 0 1 1h13.2a1 1 0 0 0 1-1v-1.3c0-3-3.5-5.4-7.6-5.4z" />
  ),
  server: (
    <path d="M4.5 3h15A1.5 1.5 0 0 1 21 4.5v5A1.5 1.5 0 0 1 19.5 11h-15A1.5 1.5 0 0 1 3 9.5v-5A1.5 1.5 0 0 1 4.5 3zm2 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm-2 7h15a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-5A1.5 1.5 0 0 1 4.5 13zm2 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />
  ),
};

export const Icon = ({
  name,
  className,
  style,
}: {
  name: IconName;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    style={style}
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    {ICONS[name]}
  </svg>
);
