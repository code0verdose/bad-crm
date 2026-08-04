import { type Locator, type Page } from '@playwright/test';

/**
 * The sign-in screen, addressed the way a person addresses it.
 *
 * Locators go through roles and accessible names, not `data-testid` and not CSS. Two reasons, and
 * the second is the one that matters here: a locator that resolves by role **is** the accessibility
 * assertion — a field whose label is not tied to it stops being findable, so a regression in
 * labelling fails the scenario rather than passing quietly next to an axe audit that runs elsewhere.
 *
 * The names come from the catalogue, so the object works in both languages: `packages/e2e` may not
 * import product sources (`rules/frontend-fsd.mdc` on the black box), so the two labels it needs are
 * written out here — and `test/e2e/locale-labels-parity.test.ts` fails when they drift from
 * `shared/i18n/locales/<lang>/auth.json`.
 */

export const LOGIN_LABELS = {
  en: { email: 'Email address', password: 'Password', submit: 'Sign in' },
  ru: { email: 'Адрес электронной почты', password: 'Пароль', submit: 'Войти' },
} as const;

export type LoginLocale = keyof typeof LOGIN_LABELS;

export class LoginPage {
  constructor(
    private readonly page: Page,
    private readonly locale: LoginLocale = 'en',
  ) {}

  private get labels(): (typeof LOGIN_LABELS)[LoginLocale] {
    return LOGIN_LABELS[this.locale];
  }

  get email(): Locator {
    return this.page.getByRole('textbox', { name: this.labels.email });
  }

  /**
   * By role, and this is where the screen taught the object two things.
   *
   * The accessible name of a required Mantine field carries the required marker — «Password *»,
   * «Пароль *» — so `getByLabel(..., { exact: true })` finds nothing. And a substring match finds
   * **two** elements: the field and the visibility toggle beside it, whose label reads «Toggle
   * password visibility». The role narrows it to the one thing that can be typed into. Measured in
   * the browser on 2026-08-05; both wrong versions timed out on a field that was on the screen.
   */
  get password(): Locator {
    return this.page.getByRole('textbox', { name: this.labels.password });
  }

  get submit(): Locator {
    return this.page.getByRole('button', { name: this.labels.submit });
  }

  async open(): Promise<void> {
    await this.page.goto('/login');
  }

  /**
   * Chooses the language the way a person does — by clicking what is on the screen.
   *
   * The radios of a Mantine `SegmentedControl` are visually hidden inputs behind the labels, so
   * `check()` on the radio times out on «element is not visible» (measured 2026-08-05). `force: true`
   * would make it pass by clicking something nobody can click; the label is the real control.
   */
  async chooseLanguage(name: string): Promise<void> {
    await this.page.getByRole('radiogroup').getByText(name, { exact: true }).click();
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.email.fill(email);
    await this.password.fill(password);
    await this.submit.click();
  }
}
