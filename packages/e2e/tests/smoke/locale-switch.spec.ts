import { expect, test } from '@playwright/test';

import { LOGIN_LABELS, LoginPage } from '../../pages/login.page.js';

/**
 * Both languages are equal in this product (`rules/i18n.mdc`), and the switcher is on the public
 * screen — the one a person meets before they have a profile to hold a preference.
 *
 * The scenario compares against the catalogue, not against strings invented here:
 * `test/e2e/locale-labels-parity.test.ts` fails when `LOGIN_LABELS` drifts from
 * `shared/i18n/locales`. A test that carried its own copy of the wording would go green over a
 * screen that lost the translation and kept the key.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test('the language switcher changes the form, in both directions', async ({ page }) => {
  const english = new LoginPage(page, 'en');
  const russian = new LoginPage(page, 'ru');

  await english.open();
  await expect(english.submit).toBeVisible();

  await english.chooseLanguage('Русский');
  await expect(russian.submit).toBeVisible();
  await expect(russian.email).toBeVisible();

  await russian.chooseLanguage('English');
  await expect(english.submit).toBeVisible();
  await expect(english.email).toBeVisible();
});

/**
 * CONTROL: the two label sets really are different, so the assertions above cannot both pass on a
 * screen that never changed.
 */
test('CONTROL: the two languages label the form differently', () => {
  expect(LOGIN_LABELS.en.submit).not.toBe(LOGIN_LABELS.ru.submit);
  expect(LOGIN_LABELS.en.email).not.toBe(LOGIN_LABELS.ru.email);
});
