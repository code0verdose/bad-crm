import { mailLocaleOf, type MailLocale } from '@/domain/identity/mail-locale.util.js';
import { type RenderedMail } from '@/domain/identity/password-changed-mail.util.js';

export interface PasswordResetMailInput {
  /** `users.locale` of the account the token belongs to. */
  readonly locale: string;
  /** `APP_URL`; the link is absolute, because a relative one resolves against a mail client. */
  readonly appUrl: string;
  /** The single-use value. It appears in the link and in nothing else — not in the subject. */
  readonly token: string;
  /** How long the link lasts, in minutes, so the sentence and the row cannot disagree. */
  readonly lifetimeMinutes: number;
  /** The organization the account belongs to: one address may hold accounts in several. */
  readonly organizationName: string;
}

/**
 * The reset link, in the account's own language.
 *
 * ## Where the token is, and where it is not
 *
 * In the path of the link and nowhere else. Not in the subject — subjects are shown in
 * notifications, on lock screens and in mailbox previews, and are the part of a message most likely
 * to be read by somebody standing nearby. Not as a query parameter either: the SPA route is
 * `/reset-password/$token`, a path segment, because a query string is copied into `Referer` by the
 * next navigation and written to the access log of any proxy the browser passes through
 * (`docs/api/openapi.yaml`, `confirmPasswordReset`).
 *
 * ## Why the organization is named
 *
 * An address can hold an account in more than one organization on a self-hosted installation, and
 * `POST /auth/forgot-password` sends one message per account. Without the name the recipient gets
 * two identical letters and no way to tell which link belongs to which workspace. It discloses
 * nothing: the person receiving it already has an account there, and somebody who does not receives
 * no message at all.
 *
 * ## What is deliberately absent
 *
 * No name, no address of the account, and no statement about *who* asked. The message has to be
 * readable by somebody who did not ask for it and must tell them only that they can ignore it.
 */
export const renderPasswordResetMail = (input: PasswordResetMailInput): RenderedMail => {
  const link = `${input.appUrl.replace(/\/+$/, '')}/reset-password/${input.token}`;

  return TEMPLATES[mailLocaleOf(input.locale)](link, input.lifetimeMinutes, input.organizationName);
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const TEMPLATES: Readonly<
  Record<MailLocale, (link: string, minutes: number, organization: string) => RenderedMail>
> = Object.freeze({
  en: (link, minutes, organization) => ({
    subject: 'Reset your Bad CRM password',
    text: [
      `A password reset was requested for your Bad CRM account in ${organization}.`,
      `Open this link to choose a new password — it works once and expires in ${minutes} minutes:`,
      link,
      'If you did not ask for this, ignore this message: nothing has changed and the link expires on its own.',
    ].join('\n\n'),
    html: [
      `<p>A password reset was requested for your Bad CRM account in ${escapeHtml(organization)}.</p>`,
      `<p>Open this link to choose a new password — it works once and expires in ${minutes} minutes:</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
      '<p>If you did not ask for this, ignore this message: nothing has changed and the link expires on its own.</p>',
    ].join('\n'),
  }),

  ru: (link, minutes, organization) => ({
    subject: 'Сброс пароля в Bad CRM',
    text: [
      `Запрошен сброс пароля для вашей учётной записи Bad CRM в организации ${organization}.`,
      `Откройте ссылку, чтобы задать новый пароль. Она одноразовая и действует ${minutes} минут:`,
      link,
      'Если вы этого не запрашивали, просто проигнорируйте письмо: ничего не изменилось, ссылка истечёт сама.',
    ].join('\n\n'),
    html: [
      `<p>Запрошен сброс пароля для вашей учётной записи Bad CRM в организации ${escapeHtml(organization)}.</p>`,
      `<p>Откройте ссылку, чтобы задать новый пароль. Она одноразовая и действует ${minutes} минут:</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
      '<p>Если вы этого не запрашивали, просто проигнорируйте письмо: ничего не изменилось, ссылка истечёт сама.</p>',
    ].join('\n'),
  }),
});
