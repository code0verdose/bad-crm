import { expect, test } from '../../fixtures/session.fixture.js';

/**
 * The control on the role fixtures themselves — the test that fails when `test.use({ role })` stops
 * meaning anything.
 *
 * A suite whose scenarios all sign in as the owner proves nothing about the permission model, and
 * the way that happens is quiet: a fixture that falls back to the seeded owner, an account whose
 * role assignment was lost, a `role` option nobody threads through. Every one of those leaves the
 * suite green, because the owner holds all 331 keys and therefore passes every assertion any other
 * role would.
 *
 * So the two halves below are one assertion split in two: the **same screen** and the **same API
 * call**, made by two roles, answering differently. Neither half is worth anything alone —
 * «the administrator sees the roles screen» would hold for a fixture that always signs in as the
 * owner, and «the developer is refused» would hold for a fixture whose session is broken. Together
 * they can only both pass when the fixture really is signing in as two different people.
 *
 * `role:read` is the discriminator because it is live today: `/admin/roles` is guarded by it in the
 * client and `GET /roles` by it on the server, `admin` holds it and `developer` does not
 * (`SYSTEM_ROLE_PERMISSIONS`). `lead` is deliberately not among the fixtures — see
 * `fixtures/role-account.ts` for why a `leadPage` would today be a name with nothing behind it.
 */

/** What the client's guard asks for on `/admin/roles`, and what its refusal screen prints. */
const ROLES_SCREEN_PERMISSION = 'role:read';

test.describe('an administrator', () => {
  test.use({ role: 'admin' });

  test('opens the roles screen and may read a person’s permissions', async ({
    rolePage,
    roleApi,
  }) => {
    await rolePage.goto('/admin/roles');

    // Authenticated: the first navigation lands on the protected route instead of the sign-in form
    // (STORY-010-03 — «форма логина не открывается»).
    await expect(rolePage).toHaveURL(/\/admin\/roles/);
    await expect(rolePage.getByRole('heading', { name: 'Roles and permissions' })).toBeVisible();
    await expect(rolePage.getByTestId('forbidden-state')).toBeHidden();

    // The same request the developer half makes, about the same subject — the caller themselves, so
    // the two differ in the role and in nothing else. There is no self-exemption on this endpoint:
    // it is gated by `permission:override_read`, which `admin` holds and `developer` does not.
    const own = await roleApi.context.get(`/api/v1/users/${roleApi.userId}/permissions`, {
      headers: roleApi.headers,
    });

    expect(own.status(), await own.text()).toBe(200);
  });
});

test.describe('a developer', () => {
  test.use({ role: 'developer' });

  test('is signed in, and refused that screen by name', async ({ rolePage, roleApi }) => {
    await rolePage.goto('/admin/roles');

    // Still authenticated — a refusal, not a redirect. If the fixture had failed to carry a session
    // the assertion below would be met by the sign-in form rather than by the 403 screen, so the URL
    // is checked before the refusal is.
    await expect(rolePage).toHaveURL(/\/admin\/roles/);
    await expect(rolePage.getByTestId('forbidden-state')).toBeVisible();
    await expect(rolePage.getByText(ROLES_SCREEN_PERMISSION, { exact: true })).toBeVisible();

    const own = await roleApi.context.get(`/api/v1/users/${roleApi.userId}/permissions`, {
      headers: roleApi.headers,
    });

    expect(own.status(), await own.text()).toBe(403);

    // CONTROL: the session is a working one, and the 403 above is about the permission rather than
    // about a token the API does not believe — which would be 401 and would pass a `not 200` check.
    const teams = await roleApi.context.get('/api/v1/teams', { headers: roleApi.headers });

    expect(teams.status(), await teams.text()).toBe(200);
  });
});
