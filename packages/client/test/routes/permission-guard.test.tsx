import { isNotFound } from '@tanstack/react-router';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IamLib, IamService } from '@units/iam';

/**
 * Which of the two refusals a permission guard produces, and why the choice is never implicit.
 *
 * `ux-architecture.md` → «403 vs 404» draws the line by what the refusal *leaks*. For a resource
 * whose existence is itself confidential — somebody else's project, a private channel, a vault —
 * the only safe answer is «there is no such thing», word for word the answer for an address that
 * never existed. For a section every colleague can see in the navigation — `/admin/**`,
 * `/reports/**` — that same answer is a lie that costs a support ticket, and 403 naming the missing
 * permission is both honest and actionable.
 *
 * The shipped guard answered 404 to both and cited invariant 2 of `CLAUDE.md` for it — which says
 * 404 for **another organization**, not for a permission missing inside your own. Inside the
 * organization the server answers 403 (`*_forbidden` in
 * `packages/shared/src/errors/error-code.enums.ts`), so one refusal read as 403 on the wire and as
 * «not found» on the screen.
 */

const permissionsView = (granted: readonly string[]): unknown => ({
  permissions: granted,
  denied: [],
  roles: ['admin'],
  isOwner: false,
  version: 1,
});

/** The one slice of router context this guard reads, with a counter on the cache call. */
const contextWith = (
  granted: readonly string[],
): { context: { queryClient: { ensureQueryData: ReturnType<typeof vi.fn> } } } => ({
  context: {
    queryClient: {
      ensureQueryData: vi.fn(async () => await Promise.resolve(permissionsView(granted))),
    },
  },
});

const thrownBy = async (run: () => Promise<void>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }

  return undefined;
};

describe('requirePermission', () => {
  it('lets a holder of the permission through', async () => {
    const args = contextWith(['role:read']);

    await expect(
      IamService.IamGuards.requirePermission({
        permission: 'role:read',
        whenDenied: 'forbidden',
      })(args as never),
    ).resolves.toBeUndefined();

    // One question between the guard and the screen: both read the same cache entry.
    expect(args.context.queryClient.ensureQueryData).toHaveBeenCalledOnce();
  });

  it('refuses an open section with a denial that names the permission', async () => {
    const thrown = await thrownBy(async () => {
      await IamService.IamGuards.requirePermission({
        permission: 'role:read',
        whenDenied: 'forbidden',
      })(contextWith(['task:read']) as never);
    });

    expect(IamLib.isPermissionDenied(thrown)).toBe(true);
    expect((thrown as IamLib.PermissionDeniedError).permission).toBe('role:read');
    // Not the router's not-found signal: that one is taken by `notFoundComponent` and would never
    // reach the boundary that draws the 403 screen.
    expect(isNotFound(thrown)).toBe(false);
  });

  it('refuses a closed contour by not existing at all', async () => {
    const thrown = await thrownBy(async () => {
      await IamService.IamGuards.requirePermission({
        permission: 'vault_item:read',
        whenDenied: 'not-found',
      })(contextWith(['task:read']) as never);
    });

    expect(isNotFound(thrown)).toBe(true);
    expect(IamLib.isPermissionDenied(thrown)).toBe(false);
  });

  /**
   * The half of the decision that must not be delegated to a default — asserted by the **type**,
   * because nothing at runtime can see a property that was never written.
   *
   * A default either way is the failure this change exists to prevent. Default `not-found` is what
   * shipped, and it turned every admin section into «nothing here». Default `forbidden` would be
   * worse: the first domain resource with an ACL (projects, EPIC-014) would inherit it in silence
   * and start confirming, to anybody who guesses a URL, which projects exist.
   *
   * `@ts-expect-error` is a gate here rather than a comment: `tsconfig.test.json` puts `test/**` in
   * the program, so `pnpm typecheck` fails if either of these calls ever starts compiling.
   */
  it('takes the choice as a required property of a closed union', () => {
    const withoutAChoice = (): unknown =>
      // @ts-expect-error — a route that does not choose its refusal does not compile.
      IamService.IamGuards.requirePermission({ permission: 'role:read' });

    const withAThirdAnswer = (): unknown =>
      IamService.IamGuards.requirePermission({
        permission: 'role:read',
        // @ts-expect-error — the rule allows two answers; there is no third.
        whenDenied: 'maybe',
      });

    expect(withoutAChoice).toBeTypeOf('function');
    expect(withAThirdAnswer).toBeTypeOf('function');
  });
});

/**
 * The route as it ships: the guard, the router's boundary and the screen — wired.
 *
 * The cases above are pure functions and prove only what they are. What is asserted here is that
 * the refusal travels: `beforeLoad` throws, the router routes it to `errorComponent` rather than to
 * `notFoundComponent`, and the default error component recognises it instead of showing the generic
 * «this page could not be opened».
 */
describe('/admin/roles for somebody who may not read roles', () => {
  const platformFetch = globalThis.fetch;

  let requested: string[];

  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    });

  const startAt = async (
    path: string,
    granted: readonly string[],
    { failPermissions = false }: { readonly failPermissions?: boolean } = {},
  ): Promise<void> => {
    vi.resetModules();
    vi.stubGlobal('fetch', async (input: Request) => {
      const url = new URL(input.url).pathname;

      requested.push(url);

      if (url.endsWith('/me/permissions')) {
        return failPermissions
          ? json({ code: 'internal_error', status: 500 }, 500)
          : json(permissionsView(granted));
      }

      return json({ status: 'ok' });
    });

    const { renderApp } = await import('../support/render-app.util.js');

    renderApp({ path, status: 'authenticated' });
  };

  beforeEach(() => {
    requested = [];
  });

  afterEach(() => {
    vi.stubGlobal('fetch', platformFetch);
  });

  it('explains the refusal instead of pretending the section is not there', async () => {
    await startAt('/admin/roles', ['task:read']);

    expect(await screen.findByTestId('forbidden-state')).toHaveTextContent('role:read');
    expect(screen.queryByText('errors.not_found.title')).not.toBeInTheDocument();
  });

  /**
   * The refusal replaces the page, and its heading is the page's `h1` — so the title and the live
   * region say the refusal as well. The section's own crumb there would announce a matrix of roles
   * that the reader cannot see, while focus sits on «you may not open this».
   */
  it('names the refusal, not the section, in the title and the announcement', async () => {
    await startAt('/admin/roles', ['task:read']);

    await screen.findByRole('heading', { level: 1, name: 'errors.forbidden.title' });

    await waitFor(() => {
      expect(document.title).toBe('errors.forbidden.title · Bad CRM');
    });
    expect(screen.getByTestId('route-announcer').textContent).toBe('errors.forbidden.title');
  });

  it('leaves a way out, and asks the server for nothing the screen may not have', async () => {
    await startAt('/admin/roles', ['task:read']);

    expect(await screen.findByRole('link', { name: 'errors.forbidden.action' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    // The guard runs before the loader: a request for the matrix would mean the screen rendered
    // first and was refused per row, which is what the guard exists to avoid.
    expect(requested.some((url) => url.endsWith('/roles'))).toBe(false);
  });

  /**
   * The other side of the same boundary, and the reason it is worth a case of its own: the error
   * component now has a branch in it, and a branch is where a screen quietly starts answering «you
   * may not» to a server that merely fell over.
   *
   * The failure is produced the way it happens in production — the permissions request itself
   * fails, so `beforeLoad` rejects with an ordinary API error rather than with a refusal.
   */
  it('still shows the ordinary error state when the refusal is not a refusal', async () => {
    await startAt('/admin/roles', [], { failPermissions: true });

    expect(await screen.findByRole('alert')).toHaveTextContent('errors.route.failed');
    expect(screen.queryByTestId('forbidden-state')).not.toBeInTheDocument();
    // A failure names the page by the failure's own heading — the `h1` the reader lands on — and
    // not by the refusal it is not.
    expect(
      screen.getByRole('heading', { level: 1, name: 'errors.route.title' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(document.title).toBe('errors.route.title · Bad CRM');
    });
    expect(screen.getByTestId('route-announcer').textContent).toBe('errors.route.title');
  });
});
