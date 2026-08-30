import { mailLocaleOf, type MailLocale } from '@/domain/identity/mail-locale.util.js';
import { type RenderedMail } from '@/domain/identity/password-changed-mail.util.js';

/**
 * Which 2FA change this account owner is being told about.
 *
 * `recovery_code_used` is the one reason here that reports a *sign-in* rather than a change of
 * configuration, and it is the loudest of the five in practice: nothing about the account changed,
 * but the credential kept for "I lost my authenticator" was spent — which is exactly what a stranger
 * holding a printed sheet of codes produces, and the audit row alone reaches nobody until an
 * administrator goes looking.
 *
 * `disabled` is the self-service path (`DisableTotpUseCase`, STORY-013-04 acceptance 1) — reached
 * only after the password and a second-factor proof were both checked, so the mail is confirmation
 * rather than a warning of somebody else's action. `reset_by_admin` is the opposite fact and reads
 * that way: nobody proved anything belonging to this account to make the change, and the notice is
 * how the owner learns about it at all, since STORY-013-04 acceptance 5 requires it to reach them and
 * this codebase has no notification preference to route it through instead
 * (`ResetUserMfaUseCase` — there is nothing to switch it off in, which is what "cannot be disabled in
 * settings" reduces to for as long as that stays true).
 */
export type MfaChangeReason =
  'enabled' | 'recovery_codes_regenerated' | 'recovery_code_used' | 'disabled' | 'reset_by_admin';

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
      recovery_code_used: (url) => ({
        subject: 'A recovery code was used to sign in to your Bad CRM account',
        text: [
          'Somebody signed in to your Bad CRM account with a two-factor recovery code instead of your authenticator app. That code has been used up and will not work again.',
          'If this was not you, change your password and contact the administrator of this installation immediately.',
          `Your security settings: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>Somebody signed in to your Bad CRM account with a two-factor recovery code instead of your authenticator app. That code has been used up and will not work again.</p>',
          '<p>If this was not you, change your password and contact the administrator of this installation immediately.</p>',
          `<p><a href="${escapeHtml(url)}">Your security settings</a></p>`,
        ].join('\n'),
      }),
      disabled: (url) => ({
        subject: 'Two-factor authentication was turned off for your Bad CRM account',
        text: [
          'Two-factor authentication was just turned off on your Bad CRM account, and every recovery code was deleted.',
          'If this was not you, contact the administrator of this installation immediately.',
          `Your security settings: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>Two-factor authentication was just turned off on your Bad CRM account, and every recovery code was deleted.</p>',
          '<p>If this was not you, contact the administrator of this installation immediately.</p>',
          `<p><a href="${escapeHtml(url)}">Your security settings</a></p>`,
        ].join('\n'),
      }),
      reset_by_admin: (url) => ({
        subject: 'An administrator turned off two-factor authentication on your Bad CRM account',
        text: [
          'An administrator of this installation reset two-factor authentication on your Bad CRM account. It is now off, every recovery code was deleted, and every device you were signed in on was signed out.',
          'If you did not expect this, contact the administrator of this installation immediately.',
          `Your security settings: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>An administrator of this installation reset two-factor authentication on your Bad CRM account. It is now off, every recovery code was deleted, and every device you were signed in on was signed out.</p>',
          '<p>If you did not expect this, contact the administrator of this installation immediately.</p>',
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
      recovery_code_used: (url) => ({
        subject: 'Для входа в вашу учётную запись Bad CRM использован резервный код',
        text: [
          'В вашу учётную запись Bad CRM вошли по резервному коду двухфакторной аутентификации, а не через приложение-аутентификатор. Этот код израсходован и больше не сработает.',
          'Если это были не вы, смените пароль и немедленно свяжитесь с администратором инсталляции.',
          `Настройки безопасности: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>В вашу учётную запись Bad CRM вошли по резервному коду двухфакторной аутентификации, а не через приложение-аутентификатор. Этот код израсходован и больше не сработает.</p>',
          '<p>Если это были не вы, смените пароль и немедленно свяжитесь с администратором инсталляции.</p>',
          `<p><a href="${escapeHtml(url)}">Настройки безопасности</a></p>`,
        ].join('\n'),
      }),
      disabled: (url) => ({
        subject: 'Для вашей учётной записи Bad CRM отключена двухфакторная аутентификация',
        text: [
          'Двухфакторная аутентификация только что отключена для вашей учётной записи Bad CRM, все резервные коды удалены.',
          'Если это были не вы, немедленно свяжитесь с администратором инсталляции.',
          `Настройки безопасности: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>Двухфакторная аутентификация только что отключена для вашей учётной записи Bad CRM, все резервные коды удалены.</p>',
          '<p>Если это были не вы, немедленно свяжитесь с администратором инсталляции.</p>',
          `<p><a href="${escapeHtml(url)}">Настройки безопасности</a></p>`,
        ].join('\n'),
      }),
      reset_by_admin: (url) => ({
        subject: 'Администратор отключил двухфакторную аутентификацию вашей учётной записи Bad CRM',
        text: [
          'Администратор этой инсталляции сбросил двухфакторную аутентификацию вашей учётной записи Bad CRM. Она отключена, все резервные коды удалены, все устройства, на которых вы были авторизованы, разлогинены.',
          'Если вы этого не ожидали, немедленно свяжитесь с администратором инсталляции.',
          `Настройки безопасности: ${url}`,
        ].join('\n\n'),
        html: [
          '<p>Администратор этой инсталляции сбросил двухфакторную аутентификацию вашей учётной записи Bad CRM. Она отключена, все резервные коды удалены, все устройства, на которых вы были авторизованы, разлогинены.</p>',
          '<p>Если вы этого не ожидали, немедленно свяжитесь с администратором инсталляции.</p>',
          `<p><a href="${escapeHtml(url)}">Настройки безопасности</a></p>`,
        ].join('\n'),
      }),
    },
  });
