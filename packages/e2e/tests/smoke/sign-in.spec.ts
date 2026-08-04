import { expect, test } from '@playwright/test';

import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import { LoginPage } from '../../pages/login.page.js';

/**
 * The scenario the installation cannot ship without: a person signs in and lands in the shell.
 *
 * The one place in the suite where the form is filled in by hand — everything else starts from a
 * saved session (STORY-010-03). It runs anonymously on purpose: `storageState` here would test the
 * fixture rather than the screen.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('signing in', () => {
  test('takes a seeded owner into the shell', async ({ page }) => {
    const login = new LoginPage(page);

    await login.open();
    await login.signIn(SEED_ORGANIZATION_A.owner.email, SEED_PASSWORD);

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('main')).toBeVisible();
  });

  /**
   * A refused sign-in is one answer, never two: the form must not become a directory of who works
   * here. The assertion is that the address is **not** named in what the person sees — the wording
   * for an unknown address and for a wrong password is the same string.
   */
  test('refuses a wrong password without saying whether the address exists', async ({ page }) => {
    const login = new LoginPage(page);

    await login.open();
    await login.signIn(SEED_ORGANIZATION_A.owner.email, 'wrong-password-entirely');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).not.toContainText(SEED_ORGANIZATION_A.owner.email);
  });

  /**
   * CONTROL: the shell is behind the guard rather than merely slow to redirect. Without this, the
   * first case would pass on an application that renders `/dashboard` to anybody.
   */
  test('CONTROL: does not reach the shell without signing in', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/login/);
  });
});
