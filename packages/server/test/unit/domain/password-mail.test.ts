import { describe, expect, it } from 'vitest';

import { mailLocaleOf } from '@/domain/identity/mail-locale.util.js';
import { renderPasswordChangedMail } from '@/domain/identity/password-changed-mail.util.js';
import { renderPasswordResetMail } from '@/domain/identity/password-reset-mail.util.js';

/**
 * The two messages the authentication core sends, in both languages.
 *
 * EN and RU are equal (ADR-0019), and mail is the one surface where the *server* picks between them
 * — there is no browser to read `Accept-Language` from. So the choice is asserted here, together
 * with the two rules that make the difference between a notification and a credential: the reset
 * token appears in the link and nowhere else, and the notification carries no credential at all.
 */

const APP_URL = 'https://crm.example.com';
/**
 * Deliberately a readable sentence rather than 43 base64url characters.
 *
 * A realistic-looking token in a fixture is a value somebody copies into a seed, and it is also the
 * value a secret scanner reports — the same wording the contract uses for its own example
 * (`docs/api/openapi.yaml`, `ResetPasswordRequest`). What these tests assert is *where* the token
 * appears, and that is independent of what it looks like.
 */
const TOKEN = 'example-only-not-a-real-reset-token';

describe('choosing the language of a message', () => {
  it.each([
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['RU', 'ru'],
    ['ru_RU', 'ru'],
    ['  ru  ', 'ru'],
    ['en', 'en'],
    ['en-GB', 'en'],
    ['', 'en'],
    ['de-DE', 'en'],
  ])('reads %s as %s', (locale, expected) => {
    expect(mailLocaleOf(locale)).toBe(expected);
  });
});

describe('the reset link message', () => {
  it.each(['en', 'ru'])('puts the token in the link and never in the subject — %s', (locale) => {
    const mail = renderPasswordResetMail({
      locale,
      appUrl: APP_URL,
      token: TOKEN,
      lifetimeMinutes: 30,
      organizationName: 'Bad Company',
    });

    expect(mail.text).toContain(`${APP_URL}/reset-password/${TOKEN}`);
    expect(mail.html).toContain(`${APP_URL}/reset-password/${TOKEN}`);
    expect(mail.subject).not.toContain(TOKEN);
    expect(mail.text).toContain('30');
    expect(mail.text).toContain('Bad Company');
  });

  it('writes each language in its own language', () => {
    expect(renderPasswordResetMail(input('en')).subject).toBe('Reset your Bad CRM password');
    expect(renderPasswordResetMail(input('ru')).subject).toBe('Сброс пароля в Bad CRM');
    expect(renderPasswordResetMail(input('ru')).text).toContain('одноразовая');
  });

  /** A trailing slash on `APP_URL` must not become `//reset-password`, which some proxies rewrite. */
  it('builds one absolute link whatever APP_URL ends with', () => {
    const mail = renderPasswordResetMail({ ...input('en'), appUrl: `${APP_URL}///` });

    expect(mail.text).toContain(`${APP_URL}/reset-password/${TOKEN}`);
    expect(mail.text).not.toContain('//reset-password');
  });

  /**
   * The organization name is the one value in this message that comes from a person. It is escaped
   * in the HTML part, so a workspace called `<script>` is a workspace name and not a script.
   */
  it('escapes the organization name in the HTML part', () => {
    const mail = renderPasswordResetMail({
      ...input('en'),
      organizationName: '<script>alert(1)</script>',
    });

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  const input = (locale: string): Parameters<typeof renderPasswordResetMail>[0] => ({
    locale,
    appUrl: APP_URL,
    token: TOKEN,
    lifetimeMinutes: 30,
    organizationName: 'Bad Company',
  });
});

describe('the password-changed notification', () => {
  it.each(['en', 'ru'])('carries no credential of any kind — %s', (locale) => {
    const mail = renderPasswordChangedMail({ locale, appUrl: APP_URL, revokedSessions: 2 });

    expect(mail.text).toContain(`${APP_URL}/settings/security`);
    expect(mail.text).not.toContain('reset-password');
    expect(mail.subject).not.toContain('password=');
  });

  it('writes each language in its own language', () => {
    expect(
      renderPasswordChangedMail({ locale: 'en', appUrl: APP_URL, revokedSessions: 1 }).subject,
    ).toBe('Your Bad CRM password was changed');
    expect(
      renderPasswordChangedMail({ locale: 'ru', appUrl: APP_URL, revokedSessions: 1 }).subject,
    ).toBe('Пароль в Bad CRM изменён');
  });

  /**
   * The count is the sentence that makes the mail actionable, so all three shapes of it are
   * rendered: none, one, several. "1 devices were signed out" is the kind of detail that makes a
   * security notice read as machine-generated and therefore ignorable.
   */
  it.each([
    ['en', 0, 'No other sessions were open'],
    ['en', 1, '1 other signed-in device was signed out'],
    ['en', 4, '4 other signed-in devices were signed out'],
    ['ru', 0, 'Других открытых сессий не было'],
    ['ru', 3, 'Закрыто других сессий: 3'],
  ])('says what happened to the other sessions — %s, %i', (locale, revoked, expected) => {
    const mail = renderPasswordChangedMail({
      locale,
      appUrl: APP_URL,
      revokedSessions: revoked as number,
    });

    expect(mail.text).toContain(expected);
    expect(mail.html).toContain(expected);
  });
});
