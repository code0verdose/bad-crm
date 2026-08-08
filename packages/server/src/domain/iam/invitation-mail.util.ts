import { type MailLocale } from '@/domain/identity/mail-locale.util.js';
import { type RenderedMail } from '@/domain/identity/password-changed-mail.util.js';

export interface InvitationMailInput {
  /** The language the invitation was created in — `invitations.locale`, already narrowed. */
  readonly locale: MailLocale;
  /** `APP_URL`; the link is absolute, because a relative one resolves against a mail client. */
  readonly appUrl: string;
  /** The single-use value. It appears in the link and in nothing else — not in the subject. */
  readonly token: string;
  /** Which workspace this is an invitation to; one address may be invited to several. */
  readonly organizationName: string;
  /** When the link stops working, so the letter and the row cannot disagree. */
  readonly expiresAt: Date;
}

/**
 * «You have been invited», in the language the inviter chose.
 *
 * ## Where the token is, and where it is not
 *
 * In the path of the link and nowhere else — the same rule as the reset letter, for the same
 * reasons: a subject is shown in notifications and on lock screens, and a query parameter is copied
 * into `Referer` by the next navigation and written to the access log of every proxy the browser
 * passes through. The client route is `/invite/$token`, a path segment.
 *
 * ## Why the locale is an argument rather than a lookup
 *
 * The recipient has no account, so there is no `users.locale` to read — this letter goes to somebody
 * the system has never seen. What it uses instead is the language the inviter was working in, stored
 * on the invitation so that a resend produces the same letter as the first attempt rather than a
 * second one in a different language.
 *
 * ## Why the expiry is a date and not «7 days»
 *
 * A letter read three days later would be wrong, and the reader has no way to know it. The date is
 * rendered in UTC, which is stated in the sentence: the server has no timezone for a person who does
 * not exist yet, and quietly using its own would be a date that is off by one for half the planet.
 *
 * ## What is deliberately absent
 *
 * No name of the inviter, no role, no teams. What somebody will be able to do here is a property of
 * this organization's configuration, and a letter that lists it hands a stranger — anybody who reads
 * a forwarded message — a description of the workspace's internal structure. The person finds out
 * when they accept, which is when they are inside.
 */
export const renderInvitationMail = (input: InvitationMailInput): RenderedMail => {
  const link = invitationLinkOf(input.appUrl, input.token);
  const expiry = formatExpiry(input.locale, input.expiresAt);

  return TEMPLATES[input.locale](link, expiry, input.organizationName);
};

/**
 * Where an invitation is accepted, absolute.
 *
 * Exported because two places need the same URL and must not each build their own: the letter, and
 * the response that hands the link back to the inviter for an installation with no relay. Two
 * spellings of it would mean the copied link and the mailed one could differ by a slash.
 */
export const invitationLinkOf = (appUrl: string, token: string): string =>
  `${appUrl.replace(/\/+$/, '')}/invite/${token}`;

/** The day the link dies, in UTC — the only timezone the server can honestly claim here. */
const formatExpiry = (locale: MailLocale, expiresAt: Date): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(expiresAt);

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const TEMPLATES: Readonly<
  Record<MailLocale, (link: string, expiry: string, organization: string) => RenderedMail>
> = Object.freeze({
  en: (link, expiry, organization) => ({
    subject: `You have been invited to ${organization} on Bad CRM`,
    text: [
      `You have been invited to join ${organization} on Bad CRM.`,
      `Open this link to create your account — it works once and stops working on ${expiry} (UTC):`,
      link,
      'If you were not expecting this, ignore the message: no account exists until the link is used, and it expires on its own.',
    ].join('\n\n'),
    html: [
      `<p>You have been invited to join ${escapeHtml(organization)} on Bad CRM.</p>`,
      `<p>Open this link to create your account — it works once and stops working on ${escapeHtml(expiry)} (UTC):</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
      '<p>If you were not expecting this, ignore the message: no account exists until the link is used, and it expires on its own.</p>',
    ].join('\n'),
  }),

  ru: (link, expiry, organization) => ({
    subject: `Приглашение в ${organization} — Bad CRM`,
    text: [
      `Вас пригласили в ${organization} в Bad CRM.`,
      `Откройте ссылку, чтобы создать учётную запись. Она одноразовая и перестанет работать ${expiry} (UTC):`,
      link,
      'Если вы этого не ждали, просто проигнорируйте письмо: учётная запись не появится, пока ссылкой не воспользуются, а сама она истечёт.',
    ].join('\n\n'),
    html: [
      `<p>Вас пригласили в ${escapeHtml(organization)} в Bad CRM.</p>`,
      `<p>Откройте ссылку, чтобы создать учётную запись. Она одноразовая и перестанет работать ${escapeHtml(expiry)} (UTC):</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
      '<p>Если вы этого не ждали, просто проигнорируйте письмо: учётная запись не появится, пока ссылкой не воспользуются, а сама она истечёт.</p>',
    ].join('\n'),
  }),
});
