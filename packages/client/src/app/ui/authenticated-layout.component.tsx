import { Outlet } from '@tanstack/react-router';

import { AppShell } from '@widgets/app-shell';
import { MfaGraceBanner } from '@widgets/mfa-grace-banner';

/**
 * What the `_authenticated` branch renders: the shell once, and whichever screen the URL selects
 * inside it.
 *
 * Mounted by the pathless layout route, so the shell is not re-created on every navigation — the
 * sidebar keeps its scroll position and the drawer its state, and only `<Outlet />` changes.
 */
export function AuthenticatedLayout() {
  return (
    <AppShell>
      {/*
        Above the screen and inside the shell, so it is on every page of the protected half rather
        than on one somebody may never open — a deadline shown only where it is convenient is a
        deadline that arrives as a surprise (STORY-013-05, acceptance 4). It renders nothing at all
        for a session the policy does not cover, which is every session until one is switched on.
      */}
      <MfaGraceBanner />
      <Outlet />
    </AppShell>
  );
}
