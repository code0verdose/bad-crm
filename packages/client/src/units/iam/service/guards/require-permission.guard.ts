import { notFound } from '@tanstack/react-router';
import { SharedPermissions } from '@bad-crm/shared';

import { fetchMyPermissions, type MyPermissions } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';

/** The slice of `beforeLoad` arguments this guard reads — narrow, so a unit never names `app/`. */
export interface PermissionGuardArgs {
  readonly context: {
    readonly queryClient: {
      ensureQueryData: (options: {
        queryKey: readonly unknown[];
        queryFn: () => Promise<MyPermissions>;
      }) => Promise<MyPermissions>;
    };
  };
}

/**
 * Keeps a screen out of reach of somebody who may not use it — **as a courtesy, not as security**.
 *
 * Every request the screen would make is authorised again on the server, so what this buys is the
 * difference between «this page is not for you» and a page that renders and then fills with 403s.
 * It runs in `beforeLoad`, before the loaders and before the first frame, which is what makes the
 * difference visible: nothing is requested and nothing is drawn.
 *
 * The permissions come from the same cache the components read, through `ensureQueryData` — so the
 * guard and the screen ask once between them, and a person who navigates here twice does not pay
 * for it twice.
 */
export const requirePermission =
  (permission: SharedPermissions.PermissionKey) =>
  async ({ context }: PermissionGuardArgs): Promise<void> => {
    const view = await context.queryClient.ensureQueryData({
      queryKey: QueryKeys.Permissions.mine(),
      queryFn: () => fetchMyPermissions(),
    });

    const known = (keys: readonly string[]): Set<SharedPermissions.PermissionKey> =>
      new Set(
        keys.filter((key): key is SharedPermissions.PermissionKey =>
          SharedPermissions.isPermissionKey(key),
        ),
      );

    const allowed = SharedPermissions.can(
      {
        isOwner: view.isOwner,
        permissions: known(view.permissions),
        denied: known(view.denied),
      },
      permission,
    );

    if (allowed) return;

    // **Not found, not forbidden** — the same answer the server gives for a resource of another
    // organization, and for the same reason: a screen that says «you may not» tells somebody what
    // exists (`ux-architecture.md`, «403 vs 404»; invariant 2 of CLAUDE.md). The route simply is
    // not there for them, and `defaultNotFoundComponent` renders inside the shell, so the way out
    // is still on screen.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw notFound();
  };
