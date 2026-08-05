import { expect, test } from '../../fixtures/session.fixture.js';
import { test as anonymous } from '@playwright/test';

/**
 * The session every other scenario starts from, and the two halves that make it worth having.
 *
 * A context carrying a minted session really is signed in; a context without one really is not. The
 * second half is not a formality — a guard that let an anonymous visitor through would make every
 * «signed in as the owner» assertion in the suite meaningless.
 *
 * Sessions are minted per test rather than saved to a file and shared. That is forced by the
 * product: the client exchanges the refresh cookie on load, and rotation with reuse detection makes
 * a shared cookie a one-shot credential — the second context to present it looks exactly like a
 * stolen one, and the family is revoked. See `fixtures/session.fixture.ts`.
 */

test.describe('a minted session', () => {
  test('opens a protected route without meeting the sign-in form', async ({ ownerPage }) => {
    await ownerPage.goto('/dashboard');

    await expect(ownerPage).toHaveURL(/\/dashboard/);
    await expect(ownerPage.getByRole('main')).toBeVisible();
  });
});

anonymous.describe('no session', () => {
  anonymous.use({ storageState: { cookies: [], origins: [] } });

  /**
   * CONTROL: without this the case above proves only that `/dashboard` renders — which it would
   * also do if the guard were gone. The pair is the assertion.
   */
  anonymous('CONTROL: is sent to the sign-in form and told where it was going', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/login\?redirect=/);
  });
});
