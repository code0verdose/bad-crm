import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type MailPort } from '@/application/platform/ports/mail.port.js';
import { NodemailerMailAdapter } from '@/infrastructure/mail/nodemailer.adapter.js';
import { createSmtpTransport } from '@/infrastructure/mail/smtp-transport.factory.js';
import { UnconfiguredMailAdapter } from '@/infrastructure/mail/unconfigured-mail.adapter.js';

/** A mailer plus the pool it may be holding, so shutdown has something to close. */
export interface ClosableMailPort extends MailPort {
  close(): Promise<void>;
}

export interface MailerInput {
  /** `SMTP_URL` as parsed by the env schema — absent means this installation sends no mail. */
  readonly smtpUrl: string | undefined;
  /**
   * `MAIL_FROM` — the envelope sender, required by the schema whenever `SMTP_URL` is set, and
   * therefore present whenever the SMTP adapter is the one being built.
   */
  readonly mailFrom: string | undefined;
  readonly logger: LoggerPort;
}

/**
 * The mailer this installation gets, decided once at startup.
 *
 * Two adapters rather than one adapter with a flag: with a flag, every future caller has to
 * remember that "sent" may mean "discarded", and one that forgets ships a password reset that
 * silently goes nowhere. The choice is made here, in the composition root's reach, and the port
 * `isConfigured()` is what the use-case checks — **before** it resolves an address, so that
 * `POST /auth/forgot-password` answers the same thing whether or not the account exists.
 *
 * Both adapters expose `close()`, so the shutdown step is registered unconditionally and does not
 * become a conditional the day mail is switched off in production.
 *
 * `mailFrom` is checked here rather than assumed. The env schema makes it required whenever
 * `SMTP_URL` is set, so this branch is unreachable through `loadEnv` — and a composition root that
 * grows a second way to build a mailer would otherwise construct a transport that no relay checking
 * its envelope will accept, which is a failure only production can show.
 */
export const createMailer = (input: MailerInput): ClosableMailPort => {
  if (input.smtpUrl === undefined) return new UnconfiguredMailAdapter(input.logger);

  if (input.mailFrom === undefined) {
    throw new Error(
      'SMTP_URL is set without MAIL_FROM: a relay that checks the envelope sender refuses every message. Set MAIL_FROM (docs/runbooks/install.md).',
    );
  }

  return new NodemailerMailAdapter(
    createSmtpTransport(input.smtpUrl),
    input.logger,
    input.mailFrom,
  );
};
