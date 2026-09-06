import { type Locator, type Page } from '@playwright/test';

/**
 * The registration screen, addressed the way a person addresses it.
 *
 * Same discipline as `login.page.ts`: locators resolve by role and accessible name rather than by
 * `data-testid` or CSS, so a field whose label stops being tied to it stops being findable and the
 * scenario fails instead of quietly passing beside an axe audit that runs elsewhere.
 *
 * The labels are written out here because `packages/e2e` may not import product sources, and
 * `test/e2e/locale-labels-parity.test.ts` is what keeps the copy honest — it reads
 * `shared/i18n/locales/<lang>/auth.json` and fails the moment the catalogue is reworded.
 */

export const REGISTER_LABELS = {
  en: {
    organizationName: 'Organization name',
    slug: 'Short address',
    email: 'Email address',
    password: 'Password',
    confirmPassword: 'Repeat the password',
    submit: 'Create the organization',
  },
  ru: {
    organizationName: 'Название организации',
    slug: 'Короткий адрес',
    email: 'Адрес электронной почты',
    password: 'Пароль',
    confirmPassword: 'Повторите пароль',
    submit: 'Создать организацию',
  },
} as const;

export type RegisterLocale = keyof typeof REGISTER_LABELS;

export interface RegistrationInput {
  readonly organizationName: string;
  readonly slug: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Anchors an accessible name at its start, escaping nothing else.
 *
 * Two independent reasons, and both were measured rather than guessed. Mantine puts the required
 * marker inside the accessible name — «Password *» — so an exact match finds nothing. And
 * `getByRole` matches a `name` option as a **substring**, so the plain string «Password» resolves
 * to two fields on this screen, the password and «Repeat the password». Anchoring at the start
 * separates them and keeps tolerating the marker at the end.
 */
const startsWith = (label: string): RegExp =>
  new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

export class RegisterPage {
  constructor(
    private readonly page: Page,
    private readonly locale: RegisterLocale = 'en',
  ) {}

  private get labels(): (typeof REGISTER_LABELS)[RegisterLocale] {
    return REGISTER_LABELS[this.locale];
  }

  get organizationName(): Locator {
    return this.page.getByRole('textbox', { name: startsWith(this.labels.organizationName) });
  }

  get slug(): Locator {
    return this.page.getByRole('textbox', { name: startsWith(this.labels.slug) });
  }

  get email(): Locator {
    return this.page.getByRole('textbox', { name: startsWith(this.labels.email) });
  }

  get password(): Locator {
    return this.page.getByRole('textbox', { name: startsWith(this.labels.password) });
  }

  get confirmPassword(): Locator {
    return this.page.getByRole('textbox', { name: startsWith(this.labels.confirmPassword) });
  }

  get submit(): Locator {
    return this.page.getByRole('button', { name: this.labels.submit });
  }

  async open(): Promise<void> {
    await this.page.goto('/register');
  }

  /** Fills the five fields and submits — the confirmation repeats the password, as a person does. */
  async register(input: RegistrationInput): Promise<void> {
    await this.organizationName.fill(input.organizationName);
    await this.slug.fill(input.slug);
    await this.email.fill(input.email);
    await this.password.fill(input.password);
    await this.confirmPassword.fill(input.password);
    await this.submit.click();
  }
}
