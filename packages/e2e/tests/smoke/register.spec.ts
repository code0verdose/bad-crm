import { expect, test } from '@playwright/test';

import { SEED_PASSWORD } from '../../fixtures/seed-data.js';
import {
  testOrganizationOwnerEmail,
  testOrganizationSlug,
} from '../../fixtures/test-organization.js';
import { LoginPage } from '../../pages/login.page.js';
import { RegisterPage } from '../../pages/register.page.js';
import { audit } from '../support/audit.util.js';

/**
 * The first door of an installation: somebody with a browser and no account creates an organization.
 *
 * This is the one scenario in the suite that starts from nothing. Every other one — the sign-in
 * smoke included — begins from an organization `pnpm db:seed` created, so the registration screen
 * could be broken end to end and the run would stay green. That is exactly what happened between
 * the day the endpoint shipped and the day the screen did: `POST /auth/register` was covered by
 * server tests the whole time, and there was no way to reach it from a browser at all.
 *
 * ## The budget this spec spends, and why it is one submit
 *
 * `organization_registration` is **3 an hour, keyed on the calling address**, and the refusal blocks
 * for an hour (`infrastructure/rate-limit/rate-limit-policy.constant.ts`). It is not the
 * fifteen-minute budget the rest of the suite lives inside, and it is spent by the whole machine at
 * once, so **each POST here costs a third of the hour's reruns for every scenario and every
 * developer on that address**.
 *
 * That is why the obvious second case — a slug that is already taken, refused under the field
 * rather than as a toast — is deliberately not here. It is a second POST, it would halve the
 * suite's rerun rate to make one assertion about an error message, and the same binding is asserted
 * where it is free: `packages/client/src/units/auth/ui/register-form.component.test.tsx` renders the
 * refusal into the field. What only a running installation can prove is the whole round trip, and
 * that is what is left.
 *
 * If this scenario fails on a refusal rather than an assertion, the answer is to wait for the
 * window, not to widen the policy: it is the guard that stops an anonymous visitor allocating
 * tenants and argon2id digests, and the suite would be the only beneficiary of a weaker one.
 *
 * ## What it leaves behind
 *
 * One organization, permanently — `fixtures/test-organization.ts` sets out why the product offers
 * no way to take it back and what an operator does about it.
 *
 * Anonymous on purpose: `redirectIfAuthed` on `/register` carries a signed-in visitor away, so a
 * scenario that inherited a session would exercise the guard and never see the form.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('registering an organization', () => {
  test('takes its owner from the form into the shell, and the account works afterwards', async ({
    page,
  }) => {
    const slug = testOrganizationSlug();
    const email = testOrganizationOwnerEmail(slug);
    const register = new RegisterPage(page);

    await register.open();

    // Audited before the form is filled in rather than after: this is the state a stranger meets,
    // and on an installation nobody has registered in yet it is the only state this screen has
    // (`rules/a11y.mdc` — every screen the suite visits is audited in the same run).
    await audit(page);

    await register.register({
      organizationName: `End-to-end ${slug}`,
      slug,
      email,
      password: SEED_PASSWORD,
    });

    // The screen does not navigate. The mutation records the session and announces it, the router
    // re-checks its guards, and `redirectIfAuthed` on `/register` is what carries the new owner
    // into the application (`pages/register/page.tsx`) — so the assertion is on where they land.
    await expect(
      page,
      'registration did not reach the shell. Two causes look identical from here and neither is a ' +
        'defect: the hourly `organization_registration` budget is spent (wait for the window ' +
        'rather than widening it), or the installation has REGISTRATION_OPEN=false and answered ' +
        '403 — the screen swaps the form for a notice only after a submit, so nothing earlier in ' +
        'this scenario could have told the two apart',
    ).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('main')).toBeVisible();

    /*
      The organization's name is deliberately **not** asserted on the screen, although STORY-010-04
      asks for it: the shell does not render it. Nothing under `widgets/app-shell` mentions an
      organization, and the only place in the client that knows an organization's name is the
      registration unit itself. Asserting it here would mean putting it into the interface to
      satisfy a test, which is the wrong way round — so the criterion is recorded as unmet in the
      story instead of quietly satisfied by something else.

      What proves the organization is real is the leg below: the session is thrown away and the
      account signs in again through the form. A registration that only minted a session — the
      failure this catches, and the one no server test can see — would put the owner in the shell
      and refuse them for ever after.
    */
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    const login = new LoginPage(page);

    await login.signIn(email, SEED_PASSWORD);

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('main')).toBeVisible();
  });

  /**
   * CONTROL: the route exists, admits a stranger, and renders a form that can be filled in.
   *
   * It separates «the submission was refused» from «the screen never got there» — a broken route, a
   * guard that turns anonymous visitors away, a chunk that fails to load. That is the whole of what
   * it can say, and the boundary is worth naming: **it cannot tell whether this installation
   * accepts new organizations.** Nothing published before a session exists says so — `GET
   * /api/v1/meta` answers an API version and a clock — and the screen therefore offers the form to
   * everybody and swaps it for a notice only once the server has answered 403
   * (`use-registration.hook.ts`, `isClosed`, «It can only be true after a submit»). On an
   * installation with `REGISTRATION_OPEN=false` this control passes and the scenario above fails;
   * the reason is written into that scenario's own assertion message, which is the only place it
   * can be said in time to be useful.
   */
  test('CONTROL: the registration form is reachable by a stranger', async ({ page }) => {
    const register = new RegisterPage(page);

    await register.open();

    await expect(register.organizationName).toBeVisible();
    await expect(register.submit).toBeVisible();
  });
});
