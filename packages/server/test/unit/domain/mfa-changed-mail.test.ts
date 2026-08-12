import { describe, expect, it } from 'vitest';

import {
  renderMfaChangedMail,
  type MfaChangeReason,
} from '@/domain/identity/mfa-changed-mail.util.js';

const APP_URL = 'https://crm.example.com';

const REASONS: readonly MfaChangeReason[] = [
  'enabled',
  'recovery_codes_regenerated',
  'disabled',
  'reset_by_admin',
];

/**
 * Every reason this notice can carry, in both languages this codebase treats as equal
 * (`rules/i18n.mdc`). Neither the English nor the Russian half of `TEMPLATES` was proven by a test
 * of its own before this file: `confirm-totp.use-case.test.ts` and
 * `regenerate-recovery-codes.use-case.test.ts` only ever exercise the account fixture's own locale
 * ('en'), which is what let the `ru` half of every reason — old and new — go unmeasured.
 */
describe('renderMfaChangedMail', () => {
  it.each(REASONS)('renders %s in English with the security-settings link', (reason) => {
    const mail = renderMfaChangedMail({ locale: 'en', appUrl: APP_URL, reason });

    expect(mail.subject.length).toBeGreaterThan(0);
    expect(mail.text).toContain(`${APP_URL}/settings/security`);
    expect(mail.html).toContain(`${APP_URL}/settings/security`);
  });

  it.each(REASONS)('renders %s in Russian with the security-settings link', (reason) => {
    const mail = renderMfaChangedMail({ locale: 'ru', appUrl: APP_URL, reason });

    expect(mail.subject.length).toBeGreaterThan(0);
    expect(mail.text).toContain(`${APP_URL}/settings/security`);
    expect(mail.html).toContain(`${APP_URL}/settings/security`);
  });

  it('answers English for a locale this installation does not translate', () => {
    const en = renderMfaChangedMail({ locale: 'en', appUrl: APP_URL, reason: 'disabled' });
    const fallback = renderMfaChangedMail({ locale: 'fr', appUrl: APP_URL, reason: 'disabled' });

    expect(fallback.subject).toBe(en.subject);
  });

  it('trims a trailing slash from appUrl before building the link', () => {
    const mail = renderMfaChangedMail({
      locale: 'en',
      appUrl: `${APP_URL}/`,
      reason: 'reset_by_admin',
    });

    expect(mail.text).toContain(`${APP_URL}/settings/security`);
    expect(mail.text).not.toContain(`${APP_URL}//settings/security`);
  });
});
