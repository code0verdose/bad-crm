import { describe, expect, it } from 'vitest';

import { LOGIN_LABELS } from '../../packages/e2e/pages/login.page.js';
import { REGISTER_LABELS } from '../../packages/e2e/pages/register.page.js';
import { readJson, recordRead } from '../repo/repo-fixture.util.js';

/**
 * The labels the end-to-end suite types against are the labels the product renders.
 *
 * `packages/e2e` may not import product sources — a scenario that imported them could pass against
 * code that is not deployed — so each page object carries its own copy of the field labels and the
 * submit button. This gate is what keeps the copies honest, and the failure it exists for is the
 * quiet one: somebody rewords «Sign in» in the catalogue, every scenario starts timing out on a
 * button that is on the screen, and the run reads as «the form is broken».
 *
 * Only the strings a locator needs. This is not a translation audit — that is
 * `packages/client/test/i18n/**`, over the whole catalogue in both languages.
 */

interface LabelledField {
  readonly label: string;
}

interface AuthCatalogue {
  readonly login: {
    readonly email: LabelledField;
    readonly password: LabelledField;
    readonly submit: string;
  };
  readonly register: {
    readonly organizationName: LabelledField;
    readonly slug: LabelledField;
    readonly email: LabelledField;
    readonly password: LabelledField;
    readonly confirmPassword: LabelledField;
    readonly submit: string;
  };
}

const catalogue = (language: 'en' | 'ru'): AuthCatalogue => {
  const path = `packages/client/src/shared/i18n/locales/${language}/auth.json`;

  return readJson<AuthCatalogue>(path);
};

recordRead('packages/e2e/pages/login.page.ts');
recordRead('packages/e2e/pages/register.page.ts');

describe('the page object types against the shipped catalogue', () => {
  it.each(['en', 'ru'] as const)('%s sign-in labels match', (language) => {
    const { login } = catalogue(language);

    expect({
      email: login.email.label,
      password: login.password.label,
      submit: login.submit,
    }).toEqual(LOGIN_LABELS[language]);
  });

  /**
   * The registration object needs the same gate for a sharper reason than the sign-in one: two of
   * its six locators are told apart only by where the accessible name starts — «Password» and
   * «Repeat the password» — so a rewording that made one a prefix of the other would not time out.
   * It would resolve to two elements and fail with «strict mode violation», three files away from
   * the catalogue entry that caused it.
   */
  it.each(['en', 'ru'] as const)('%s registration labels match', (language) => {
    const { register } = catalogue(language);

    expect({
      organizationName: register.organizationName.label,
      slug: register.slug.label,
      email: register.email.label,
      password: register.password.label,
      confirmPassword: register.confirmPassword.label,
      submit: register.submit,
    }).toEqual(REGISTER_LABELS[language]);
  });

  /**
   * CONTROL: the two languages differ, so a comparison cannot be satisfied by a catalogue that lost
   * one of them and fell back to the other.
   */
  it('CONTROL: the catalogues are not the same catalogue', () => {
    expect(catalogue('en').login.submit).not.toBe(catalogue('ru').login.submit);
    expect(catalogue('en').register.submit).not.toBe(catalogue('ru').register.submit);
  });
});
