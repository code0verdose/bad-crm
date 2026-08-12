import { mailLocaleOf, type MailLocale } from '@/domain/identity/mail-locale.util.js';
import { type RenderedMail } from '@/domain/identity/password-changed-mail.util.js';

/** Which of the two 2FA changes this account owner is being told about. */
export type MfaChangeReason = 'enabled' | 'recovery_codes_regenerated';

export interface MfaChangedMailInput {
  /** `users.locale` of the account, as stored. Anything that is not Russian is answered in English. */
  readonly locale: string;
  /** `APP_URL`; the message links to the security page of this installation and to no other. */
  readonly appUrl: string;
  readonly reason: MfaChangeReason;
}

/**
 * "Two-factor authentication was turned on" / "your recovery codes were regenerated", in the
 * account's own language — the notice `ChangePasswordUseCase` already sends for the same class of
 * event (a credential controlling the account changed), extended to the two 2FA operations that
 * change one.
 *
 * ## Why this exists
 *
 * Enabling 2FA or regenerating recovery codes are both privileged changes a hijacked session, not
 * just a stolen password, can make (`ConfirmTotpUseCase`'s docstring, «A session is not the second
 * factor»): both now require the current password too, but a mail is the one signal that reaches the
 * account owner through a channel the session itself does not control. Without it, "somebody enabled
 * 2FA with an authenticator I never scanned" or "somebody reissued my recovery codes" would leave no
 * trace the owner could see outside the audit log an administrator reads later.
 *
 * ## What is in it, and what is deliberately not
 *
 * No secret, no code, no link that changes anything — the same restraint `renderPasswordChangedMail`
 * documents at length. It is a notice, not an action a mail client can take on the reader's behalf.
 */
export const renderMfaChangedMail = (input: MfaChangedMailInput): RenderedMail => {
  const securityUrl = `${input.appUrl.replace(/\/+$/, '')}/settings/security`;

  return TEMPLATES[mailLocaleOf(input.locale)][input.reason](securityUrl);
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

type Renderer = (url: string) => RenderedMail;

const TEMPLATES: Readonly<Record<MailLocale, Readonly<Record<MfaChangeReason, Renderer>>>> =
  Object.freeze({
    en: {
      enabled: (url) => ({
        subject: 'Two-factor authentication was turned on for your Bad CRM account',
        text: [
          'Two-factor authentication was just enabled on your Bad CRM account.',
          'If this was not you, contact the administrator of this installation immediately.',
          `Your security settings: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>Two-factor authentication was just enabled on your Bad CRM account.</p>',
          '<p>If this was not you, contact the administrator of this installation immediately.</p>',
          `<p><a href="${escapeHtml(url)}">Your security settings</a></p>`,
        ].join('\n'),
      }),
      recovery_codes_regenerated: (url) => ({
        subject: 'Your Bad CRM recovery codes were regenerated',
        text: [
          'The two-factor recovery codes for your Bad CRM account were just regenerated. Every previous code stopped working.',
          'If this was not you, contact the administrator of this installation immediately.',
          `Your security settings: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>The two-factor recovery codes for your Bad CRM account were just regenerated. Every previous code stopped working.</p>',
          '<p>If this was not you, contact the administrator of this installation immediately.</p>',
          `<p><a href="${escapeHtml(url)}">Your security settings</a></p>`,
        ].join('\n'),
      }),
    },

    ru: {
      enabled: (url) => ({
        subject: 'Для вашей учётной записи Bad CRM включена двухфакторная аутентификация',
        text: [
          'Двухфакторная аутентификация только что включена для вашей учётной записи Bad CRM.',
          'Если это были не вы, немедленно свяжитесь с администратором инсталляции.',
          `Настройки безопасности: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>Двухфакторная аутентификация только что включена для вашей учётной записи Bad CRM.</p>',
          '<p>Если это были не вы, немедленно свяжитесь с администратором инсталляции.</p>',
          `<p><a href="${escapeHtml(url)}">Настройки безопасности</a></p>`,
        ].join('\n'),
      }),
      recovery_codes_regenerated: (url) => ({
        subject: 'Резервные коды Bad CRM перевыпущены',
        text: [
          'Резервные коды двухфакторной аутентификации вашей учётной записи Bad CRM только что перевыпущены. Все прежние коды перестали работать.',
          'Если это были не вы, немедленно свяжитесь с администратором инсталляции.',
          `Настройки безопасности: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>Резервные коды двухфакторной аутентификации вашей учётной записи Bad CRM только что перевыпущены. Все прежние коды перестали работать.</p>',
          '<p>Если это были не вы, немедленно свяжитесь с администратором инсталляции.</p>',
          `<p><a href="${escapeHtml(url)}">Настройки безопасности</a></p>`,
        ].join('\n'),
      }),
    },
  });
