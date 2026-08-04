import { expect, test } from '@playwright/test';

import { SEED_ORGANIZATION_A, sessionOf } from '../../fixtures/auth.fixture.js';

/**
 * The saved session, which every later scenario depends on and none of them can verify.
 *
 * A suite that signs in through the form in every test pays three seconds a test for a screen it is
 * not testing, and — worse — every failure of that screen becomes a failure of every scenario. So
 * the session is established once, over the API, and reused as `storageState`.
 *
 * That reuse is only sound if two things hold, and this file is where they are held: a context
 * carrying the saved state really is signed in, and a context without it really is not. The second
 * half is not a formality — a guard that lets an anonymous visitor through would make every
 * «signed in as the owner» assertion in the suite meaningless.
 */

test.describe('a saved session', () => {
  test.use({ storageState: sessionOf(SEED_ORGANIZATION_A) });

  test('opens a protected route without meeting the sign-in form', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('main')).toBeVisible();
  });
});

test.describe('no session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  /**
   * CONTROL: without this the case above proves only that `/dashboard` renders — which it would
   * also do if the guard were gone. The pair is the assertion.
   */
  test('CONTROL: is sent to the sign-in form and told where it was going', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/login\?redirect=/);
  });
});
