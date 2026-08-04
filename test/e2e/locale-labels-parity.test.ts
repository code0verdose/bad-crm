import { describe, expect, it } from 'vitest';

import { LOGIN_LABELS } from '../../packages/e2e/pages/login.page.js';
import { readJson, recordRead } from '../repo/repo-fixture.util.js';

/**
 * The labels the end-to-end suite types against are the labels the product renders.
 *
 * `packages/e2e` may not import product sources — a scenario that imported them could pass against
 * code that is not deployed — so the page object carries its own copy of the two field labels and
 * the submit button. This gate is what keeps the copy honest, and the failure it exists for is the
 * quiet one: somebody rewords «Sign in» in the catalogue, every scenario starts timing out on a
 * button that is on the screen, and the run reads as «the form is broken».
 *
 * Only the strings a locator needs. This is not a translation audit — that is
 * `packages/client/test/i18n/**`, over the whole catalogue in both languages.
 */

interface AuthCatalogue {
  readonly login: {
    readonly email: { readonly label: string };
    readonly password: { readonly label: string };
    readonly submit: string;
  };
}

const catalogue = (language: 'en' | 'ru'): AuthCatalogue => {
  const path = `packages/client/src/shared/i18n/locales/${language}/auth.json`;

  return readJson<AuthCatalogue>(path);
};

recordRead('packages/e2e/pages/login.page.ts');

describe('the page object types against the shipped catalogue', () => {
  it.each(['en', 'ru'] as const)('%s labels match', (language) => {
    const { login } = catalogue(language);

    expect({
      email: login.email.label,
      password: login.password.label,
      submit: login.submit,
    }).toEqual(LOGIN_LABELS[language]);
  });

  /**
   * CONTROL: the two languages differ, so a comparison cannot be satisfied by a catalogue that lost
   * one of them and fell back to the other.
   */
  it('CONTROL: the catalogues are not the same catalogue', () => {
    expect(catalogue('en').login.submit).not.toBe(catalogue('ru').login.submit);
  });
});
