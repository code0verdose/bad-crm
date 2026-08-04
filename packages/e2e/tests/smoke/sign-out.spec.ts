import { expect, test } from '@playwright/test';

import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import { LoginPage } from '../../pages/login.page.js';

/**
 * Signing out, and the half of it that is easy to get wrong.
 *
 * «Back» after a sign-out is the case: the shell is in the browser's history, and an application
 * that only navigates away leaves it one keypress from being shown again — with whatever it had
 * rendered still on the screen. What must happen instead is that the guard runs again and answers
 * the same way it answers a stranger.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test('signing out ends the session, and Back does not bring it back', async ({ page }) => {
  const login = new LoginPage(page);

  await login.open();
  await login.signIn(SEED_ORGANIZATION_A.owner.email, SEED_PASSWORD);
  await expect(page).toHaveURL(/\/dashboard/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  // Back, and then the same thing a bookmark does. The two are different questions: the first asks
  // whether a rendered shell is still sitting in the history, the second whether the guard runs on a
  // fresh navigation.
  //
  // The URL after Back is deliberately not asserted. Measured on 2026-08-05: the history holds no
  // `/dashboard` entry at all — the router replaces rather than pushes on both the redirect into the
  // shell and the redirect out of it — so Back leaves the application entirely. That is the stronger
  // form of the property, and pinning a URL here would assert the router's bookkeeping instead of
  // the thing that matters: no shell comes back.
  await page.goBack();
  await expect(page.getByRole('main')).toBeHidden();

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
