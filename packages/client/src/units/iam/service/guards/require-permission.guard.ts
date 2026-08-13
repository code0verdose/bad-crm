import { notFound } from '@tanstack/react-router';
import { SharedPermissions } from '@bad-crm/shared';

import { fetchMyPermissions, type MyPermissions } from '@units/iam/api';
import { PermissionDeniedError } from '@units/iam/lib';
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
 * What a refusal is allowed to reveal — the two answers of `ux-architecture.md` → «403 vs 404».
 *
 * - `'forbidden'` — the section's existence is not a secret inside the organization (`/admin/**`,
 *   `/reports/**`, `/delivery/**`, a colleague's profile). The screen names the missing permission,
 *   because a colleague can see the section in the navigation and «nothing here» would read as a
 *   defect: the person retries, then writes to support.
 * - `'not-found'` — the resource belongs to the closed contour, where the *existence* is the secret:
 *   somebody else's project, a private channel, a document, a vault item. The answer is word for
 *   word the answer for an address that never existed, and it matches what the server does for
 *   another organization (invariant 2 of `CLAUDE.md`).
 */
export type PermissionDenialKind = 'forbidden' | 'not-found';

export interface RequirePermissionOptions {
  readonly permission: SharedPermissions.PermissionKey;
  /**
   * **No default, on purpose.** A default is the whole failure this option exists to prevent.
   *
   * `'not-found'` is what the guard used to do unconditionally, and it turned every admin section
   * into «nothing here» while the server answered the very same refusal as 403 — one refusal with
   * two faces. `'forbidden'` as a default would be worse: the first domain resource with an ACL
   * (projects, EPIC-014) would inherit it in silence and start confirming, to anybody who guesses a
   * URL, which projects exist. A required property makes the author of the next route decide, and
   * makes a route that does not decide fail to compile.
   */
  readonly whenDenied: PermissionDenialKind;
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
 *
 * The refusal itself is the caller's decision, not this function's — see `whenDenied` above.
 */
export const requirePermission =
  ({ permission, whenDenied }: RequirePermissionOptions) =>
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

    // The closed contour: the route simply is not there for them. `defaultNotFoundComponent`
    // renders inside the shell, so the way out is still on screen.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (whenDenied === 'not-found') throw notFound();

    // The open section: an ordinary error, so the router hands it to `errorComponent`, which
    // recognises it and draws the screen that names the permission (`app/ui/route-error`).
    throw new PermissionDeniedError(permission);
  };
