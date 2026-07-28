import { Outlet } from '@tanstack/react-router';

import { RouteAnnouncer } from '@widgets/route-announcer';

/**
 * Everything every route gets, authenticated or not: the announcer, and the outlet.
 *
 * The shell is *not* here — the login screen and the secure-link viewer must render without it
 * (`ux-architecture.md` → «Личное vs общее», last row). What does belong to every route is the part
 * that makes a navigation perceivable at all.
 */
export function RootLayout() {
  return (
    <>
      <RouteAnnouncer />
      <Outlet />
    </>
  );
}
