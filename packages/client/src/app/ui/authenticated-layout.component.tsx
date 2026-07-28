import { Outlet } from '@tanstack/react-router';

import { AppShell } from '@widgets/app-shell';

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
      <Outlet />
    </AppShell>
  );
}
