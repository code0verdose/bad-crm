import { mailLocaleOf, type MailLocale } from '@/domain/identity/mail-locale.util.js';
import { type RenderedMail } from '@/domain/identity/password-changed-mail.util.js';

export interface RefreshReuseMailInput {
  /** `users.locale` of the account, as stored. Anything that is not Russian is answered in English. */
  readonly locale: string;
  /** `APP_URL`; the message links to the security page of this installation and to no other. */
  readonly appUrl: string;
  /**
   * How many live sessions the detection closed. Always at least one: the notice is sent by
   * `RefreshSessionUseCase` only when the revoking `UPDATE` actually matched rows, which is what
   * makes "one message per family" hold without a counter kept anywhere.
   */
  readonly revokedSessions: number;
}

/**
 * "A sign-in token of yours was replayed, so the device was signed out", in the account's language.
 *
 * ## Why the notice exists
 *
 * `rules/security.mdc` rule 8 asks for three things when a refresh token comes back after it was
 * spent: close the family, write the trail, tell the person. The first two are read by the server
 * and by an administrator; this is the only one that reaches the account owner, and it reaches them
 * through a channel the stolen session does not control. Without it, the owner's whole experience of
 * a theft is being signed out for no stated reason.
 *
 * ## What is in it
 *
 * What happened, what was done about it, and what to do next — and the count of sessions that were
 * closed, for the reason `renderPasswordChangedMail` carries the same number: it is the sentence
 * that makes the message actionable rather than ominous.
 *
 * ## What is deliberately absent, and why each one
 *
 * - **The replayed token, any part of it, and its digest.** It is a credential; a mailbox is not a
 *   place to put one, and the reason this mail is being sent is the suspicion that somebody has a
 *   copy of exactly this value.
 * - **Any link that acts.** Only `/settings/security`, which requires signing in. A "close
 *   everything" link in a mail is a credential that arrives by mail (`renderPasswordChangedMail`
 *   documents the same restraint).
 * - **The address the replay came from.** This product stores no full address at all
 *   (`docs/architecture/data-model.md`, «Про адрес сессии»), so the mail could not print one
 *   honestly, and the masked network it *could* print belongs to the request that was refused —
 *   which is to say, to whoever holds the stolen token.
 * - **The device of that request, and its user agent.** Same reason, and a sharper one: both are
 *   chosen by the caller. Anything derived from them is text an attacker composes into the victim's
 *   inbox — a forged "Chrome on Windows" that matches the owner's own laptop is a line that talks
 *   somebody out of reacting. The signal in this message is deliberately not steerable by the person
 *   who triggered it. What the owner needs in order to recognise the device is on
 *   `/settings/security`, where every row is one the server wrote.
 * - **A timestamp.** The message is handed to the transport in the same breath as the detection, so
 *   "just now" is both true and unambiguous — while a rendered time needs a timezone and a locale
 *   format, and the mail templates of this codebase deliberately hold no `Intl` (`rules/i18n.mdc`
 *   puts formatting behind the client's own wrappers).
 * - **Identifiers of the family and of the sessions.** Opaque uuids mean nothing to a reader and
 *   name rows to anybody else who gets the mailbox.
 */
export const renderRefreshReuseMail = (input: RefreshReuseMailInput): RenderedMail => {
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
    en: (url, revoked) => {
      const closed = `${revoked} ${revoked === 1 ? 'session was' : 'sessions were'} signed out on that device.`;

      return {
        subject: 'A sign-in token of your Bad CRM account was reused',
        text: [
          'A sign-in token of your Bad CRM account was presented again after it had already been used. That usually means somebody else has a copy of it.',
          `${closed} Signing in again is enough to keep working.`,
          'If you did not expect this, change your password and contact the administrator of this installation.',
          `Your active sessions: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>A sign-in token of your Bad CRM account was presented again after it had already been used. That usually means somebody else has a copy of it.</p>',
          `<p>${closed} Signing in again is enough to keep working.</p>`,
          '<p>If you did not expect this, change your password and contact the administrator of this installation.</p>',
          `<p><a href="${escapeHtml(url)}">Your active sessions</a></p>`,
        ].join('\n'),
      };
    },

    ru: (url, revoked) => {
      const closed = `Закрыто сессий на этом устройстве: ${revoked}.`;

      return {
        subject: 'Токен входа в Bad CRM использован повторно',
        text: [
          'Токен входа вашей учётной записи Bad CRM предъявлен повторно — уже после того, как он был использован. Обычно это значит, что его копия есть у кого-то ещё.',
          `${closed} Чтобы продолжить работу, достаточно войти заново.`,
          'Если вы этого не ожидали, смените пароль и свяжитесь с администратором инсталляции.',
          `Ваши активные сессии: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>Токен входа вашей учётной записи Bad CRM предъявлен повторно — уже после того, как он был использован. Обычно это значит, что его копия есть у кого-то ещё.</p>',
          `<p>${closed} Чтобы продолжить работу, достаточно войти заново.</p>`,
          '<p>Если вы этого не ожидали, смените пароль и свяжитесь с администратором инсталляции.</p>',
          `<p><a href="${escapeHtml(url)}">Ваши активные сессии</a></p>`,
        ].join('\n'),
      };
    },
  });
