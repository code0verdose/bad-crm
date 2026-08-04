import { type MouseEvent, type ReactNode } from 'react';

import { scrollToSection } from '@/shared/lib/smooth-scroll.util.js';
import { navigate, ROUTES } from '@/shared/lib/use-route.hook.js';

/**
 * A link to a section of the landing page that also works from the legal pages.
 *
 * A bare `#security` is a link to a section of *the current document*, so from `/terms` it changed
 * the address and did nothing else — there is no such section on that page. The href is therefore
 * always absolute (`/#security`): correct to copy, correct to open in a new tab, and on the home
 * page it is still an ordinary in-page anchor the browser handles by itself.
 *
 * Off the home page it takes over: render the home page first, then scroll, because the element
 * does not exist until it is mounted — `scrollToSection` waits for it and hands the work to Lenis
 * so the arrival is smoothed like every other scroll here. The address keeps the hash, so a reload
 * lands in the same place.
 */
export const SectionLink = ({
  id,
  className,
  children,
}: {
  id: string;
  className?: string | undefined;
  children: ReactNode;
}) => {
  const href = `${ROUTES.home}#${id}`;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (globalThis.location.pathname === ROUTES.home) return;

    event.preventDefault();
    navigate(ROUTES.home);

    globalThis.history.replaceState(null, '', href);
    scrollToSection(id);
  };

  return (
    <a className={className} href={href} onClick={onClick}>
      {children}
    </a>
  );
};
