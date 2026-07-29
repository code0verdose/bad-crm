import { mailLocaleOf, type MailLocale } from '@/domain/identity/mail-locale.util.js';

/** A rendered message, without the recipient — the use-case knows who it is addressing. */
export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface PasswordChangedMailInput {
  /** `users.locale` of the account, as stored. Anything that is not Russian is answered in English. */
  readonly locale: string;
  /** `APP_URL`; the message links to the security page of this installation and to no other. */
  readonly appUrl: string;
  /** How many other devices the change closed, so the reader can tell it did what they asked. */
  readonly revokedSessions: number;
}

/**
 * "Your password was changed", in the account's own language.
 *
 * ## What is in it, and what is deliberately not
 *
 * The message carries **no credential of any kind**: not the old password, not the new one, not a
 * link that would let the reader change anything without signing in. It is a notification, and a
 * notification that carried an action link would be a password reset nobody asked for — reachable by
 * anyone who reads the mailbox.
 *
 * It does carry a count of closed sessions, because that is the sentence that makes the mail
 * actionable: somebody who did change their password reads it as confirmation, and somebody who did
 * not now knows how many devices were signed out and can call an administrator.
 *
 * The link is built on `APP_URL` and is absolute. A relative link in a mail resolves against the
 * mail client's own origin, which is to say nothing at all.
 */
export const renderPasswordChangedMail = (input: PasswordChangedMailInput): RenderedMail => {
  const securityUrl = `${input.appUrl.replace(/\/+$/, '')}/settings/security`;

  return TEMPLATES[mailLocaleOf(input.locale)](securityUrl, input.revokedSessions);
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const TEMPLATES: Readonly<Record<MailLocale, (url: string, revoked: number) => RenderedMail>> =
  Object.freeze({
    en: (url, revoked) => ({
      subject: 'Your Bad CRM password was changed',
      text: [
        'The password of your Bad CRM account was just changed.',
        revoked === 0
          ? 'No other sessions were open, so nothing else was signed out.'
          : `${revoked} other signed-in ${revoked === 1 ? 'device was' : 'devices were'} signed out.`,
        'If this was not you, contact the administrator of this installation immediately.',
        `Your active sessions: ${url}`,
      ].join('\n\n'),
      html: [
        '<p>The password of your Bad CRM account was just changed.</p>',
        revoked === 0
          ? '<p>No other sessions were open, so nothing else was signed out.</p>'
          : `<p>${revoked} other signed-in ${revoked === 1 ? 'device was' : 'devices were'} signed out.</p>`,
        '<p>If this was not you, contact the administrator of this installation immediately.</p>',
        `<p><a href="${escapeHtml(url)}">Your active sessions</a></p>`,
      ].join('\n'),
    }),

    ru: (url, revoked) => ({
      subject: 'Пароль в Bad CRM изменён',
      text: [
        'Пароль вашей учётной записи Bad CRM только что изменён.',
        revoked === 0
          ? 'Других открытых сессий не было — выходить было не из чего.'
          : `Закрыто других сессий: ${revoked}.`,
        'Если это были не вы, немедленно свяжитесь с администратором инсталляции.',
        `Ваши активные сессии: ${url}`,
      ].join('\n\n'),
      html: [
        '<p>Пароль вашей учётной записи Bad CRM только что изменён.</p>',
        revoked === 0
          ? '<p>Других открытых сессий не было — выходить было не из чего.</p>'
          : `<p>Закрыто других сессий: ${revoked}.</p>`,
        '<p>Если это были не вы, немедленно свяжитесь с администратором инсталляции.</p>',
        `<p><a href="${escapeHtml(url)}">Ваши активные сессии</a></p>`,
      ].join('\n'),
    }),
  });
