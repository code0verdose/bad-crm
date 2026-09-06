import { describe, expect, it } from 'vitest';

import { renderRefreshReuseMail } from '@/domain/identity/refresh-reuse-mail.util.js';

const APP_URL = 'https://crm.example.com';

/**
 * The notice that reaches the account owner when a refresh token was replayed.
 *
 * Both languages are proven here rather than through the use-case suite, for the reason
 * `mfa-changed-mail.test.ts` states about itself: a use-case fixture carries one locale, so the
 * other half of `TEMPLATES` would ship unmeasured.
 */
describe('renderRefreshReuseMail', () => {
  it.each(['en', 'ru'])('renders in %s with the security-settings link', (locale) => {
    const mail = renderRefreshReuseMail({ locale, appUrl: APP_URL, revokedSessions: 2 });

    expect(mail.subject.length).toBeGreaterThan(0);
    expect(mail.text).toContain(`${APP_URL}/settings/security`);
    expect(mail.html).toContain(`${APP_URL}/settings/security`);
  });

  it('answers English for a locale this installation does not translate', () => {
    const en = renderRefreshReuseMail({ locale: 'en', appUrl: APP_URL, revokedSessions: 1 });
    const fallback = renderRefreshReuseMail({ locale: 'fr', appUrl: APP_URL, revokedSessions: 1 });

    expect(fallback.subject).toBe(en.subject);
  });

  it('says how many sessions were closed, in both languages', () => {
    for (const locale of ['en', 'ru']) {
      const mail = renderRefreshReuseMail({ locale, appUrl: APP_URL, revokedSessions: 3 });

      expect(mail.text).toContain('3');
      expect(mail.html).toContain('3');
    }
  });

  it('agrees with the count in English, singular and plural', () => {
    const one = renderRefreshReuseMail({ locale: 'en', appUrl: APP_URL, revokedSessions: 1 });
    const many = renderRefreshReuseMail({ locale: 'en', appUrl: APP_URL, revokedSessions: 3 });

    expect(one.text).toContain('1 session was signed out');
    expect(many.text).toContain('3 sessions were signed out');
  });

  it('trims a trailing slash from appUrl before building the link', () => {
    const mail = renderRefreshReuseMail({
      locale: 'en',
      appUrl: `${APP_URL}/`,
      revokedSessions: 1,
    });

    expect(mail.text).toContain(`${APP_URL}/settings/security`);
    expect(mail.text).not.toContain(`${APP_URL}//settings/security`);
  });

  /**
   * The message is a *notice*, on the same restraint `renderPasswordChangedMail` documents: it
   * carries no credential and no link that changes anything without signing in first. A mailbox is
   * read by whoever has the mailbox, and the reason this mail exists at all is the suspicion that
   * somebody has something they should not.
   */
  it('carries no action link beyond the security page', () => {
    const mail = renderRefreshReuseMail({ locale: 'ru', appUrl: APP_URL, revokedSessions: 1 });
    const links = [...mail.html.matchAll(/href="([^"]+)"/g)].map(([, href]) => href);

    expect(links).toEqual([`${APP_URL}/settings/security`]);
  });
});
