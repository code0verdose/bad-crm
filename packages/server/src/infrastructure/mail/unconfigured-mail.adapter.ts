import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  type MailDelivery,
  type MailPort,
  type OutgoingMail,
} from '@/application/platform/ports/mail.port.js';

/**
 * `MailPort` for an installation without `SMTP_URL`.
 *
 * It reports the absence and sends nothing. The alternative that suggests itself — writing the mail
 * to the log so a developer can read it — is not offered here: the one mail this epic sends carries
 * a password-reset token inside a URL, and the log is the least private place in the deployment
 * (`rules/observability.mdc`: the body is never logged, at any level). The development answer is
 * Mailpit, which `docker-compose.yml` already starts and whose inbox is where
 * `docs/runbooks/local-environment.md` says it is.
 *
 * The `warn` is for the operator, and it says which variable is missing rather than which message
 * was lost: an installation that silently never sends mail is a support case that takes days to
 * diagnose, and the missing configuration is the actionable half.
 */
export class UnconfiguredMailAdapter implements MailPort {
  constructor(private readonly logger: LoggerPort) {}

  isConfigured(): boolean {
    return false;
  }

  /** The message is taken and dropped unread — see the note above on why it is not logged. */
  async send(_mail: OutgoingMail): Promise<MailDelivery> {
    this.logger.warn(
      { transport: 'none' },
      'mail was requested but this installation has no SMTP_URL; nothing was sent',
    );

    return Promise.resolve({ status: 'not_configured' });
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
