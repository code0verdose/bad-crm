import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import { LoginPage } from '../../pages/login.page.js';

/**
 * The accessibility audit of the two screens every installation shows: the sign-in form and the
 * shell behind it.
 *
 * Component tests already run axe on the pieces (`rules/a11y.mdc`), and this does not replace them —
 * it asks the question they structurally cannot: what happens when the pieces are on a page
 * together, with the real theme, the real fonts and the real focus order. A contrast failure between
 * a component and the page background exists only here.
 *
 * Tags are A and AA of WCAG 2.1, which is the level `rules/a11y.mdc` requires. Best-practice rules
 * are deliberately not included: they are advice, and a suite that fails on advice gets muted.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.use({ storageState: { cookies: [], origins: [] } });

const audit = async (page: Page): Promise<void> => {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();

  expect(
    violations.map((violation) => `${violation.id}: ${violation.help}`),
    JSON.stringify(violations, null, 2),
  ).toEqual([]);
};

test.describe('accessibility', () => {
  test('the sign-in screen has no A or AA violation', async ({ page }) => {
    await new LoginPage(page).open();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await audit(page);
  });

  test('the shell has no A or AA violation', async ({ page }) => {
    const login = new LoginPage(page);

    await login.open();
    await login.signIn(SEED_ORGANIZATION_A.owner.email, SEED_PASSWORD);
    await expect(page).toHaveURL(/\/dashboard/);

    await audit(page);
  });
});
