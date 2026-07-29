import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  type MailDelivery,
  type MailFailure,
  type MailPort,
  type OutgoingMail,
} from '@/application/platform/ports/mail.port.js';
import { type MailTransport } from '@/infrastructure/mail/mail-transport.types.js';

/**
 * nodemailer's own error codes, mapped onto the closed set the port reports.
 *
 * A closed set because the reason is logged and counted: the message of an SMTP error is written by
 * the relay, quotes whatever it likes — including the credentials it just refused — and has an
 * unbounded number of shapes, which makes it useless as a metric label and unsafe as a log field.
 */
/**
 * `EENVELOPE` is `envelope_rejected` and not `recipient_rejected`, because the envelope has two
 * halves and nodemailer raises the same code for both. It used to say `recipient_rejected`, which
 * sent an operator whose relay refused the *sender* to go and check the recipient's address —
 * exactly the wrong half, on the one failure that a development Mailpit never reproduces.
 */
const FAILURE_BY_CODE: Readonly<Record<string, MailFailure>> = {
  ECONNECTION: 'connection',
  ESOCKET: 'connection',
  ETIMEDOUT: 'connection',
  EDNS: 'connection',
  EAUTH: 'authentication',
  EENVELOPE: 'envelope_rejected',
  EMESSAGE: 'envelope_rejected',
};

const failureOf = (error: unknown): MailFailure => {
  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' ? (FAILURE_BY_CODE[code] ?? 'unknown') : 'unknown';
};

/**
 * `MailPort` over SMTP.
 *
 * **Nothing about the message is logged. Not the recipient, not the subject, not a byte of the
 * body.** The recipient is personal data, the subject and body are user content
 * (`rules/observability.mdc`, rule 5), and the body of the one mail this epic sends contains a
 * single-use credential inside a URL — a log that quotes it is a log that grants password resets to
 * anybody who can read it. What is written instead is the message id the relay assigned, which is
 * the handle an operator needs to trace a delivery through their own mail server, and the class of
 * a failure. The nodemailer error object is never passed to the logger either: its `message` is
 * written by the remote relay.
 *
 * A refused delivery is returned, not thrown, because the caller has to tell it apart from "this
 * installation has no mail at all" — see `MailDelivery` in the port.
 */
export class NodemailerMailAdapter implements MailPort {
  constructor(
    private readonly transport: MailTransport,
    private readonly logger: LoggerPort,
    /**
     * `MAIL_FROM` — the mailbox this installation sends from, on every message.
     *
     * It lives on the adapter and not on `OutgoingMail` because it is configuration rather than
     * content: which mailbox an installation is allowed to send from is a property of the relay the
     * operator runs, and no use-case has an opinion about it. Carrying it in the message would mean
     * every future caller has to remember it, and the one that forgets ships a password reset that
     * a real relay refuses.
     */
    private readonly from: string,
  ) {}

  /** This adapter is built only when `SMTP_URL` is set; its existence is the configuration. */
  isConfigured(): boolean {
    return true;
  }

  async send(mail: OutgoingMail): Promise<MailDelivery> {
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
      });

      this.logger.info({ transport: 'smtp', messageId: info.messageId }, 'mail delivered');

      return { status: 'sent', messageId: info.messageId };
    } catch (error) {
      const failure = failureOf(error);

      this.logger.error({ transport: 'smtp', failure }, 'mail could not be delivered');

      return { status: 'failed', failure };
    }
  }

  /** Releases the pooled connections; registered as a shutdown step by the composition root. */
  async close(): Promise<void> {
    this.transport.close();

    return Promise.resolve();
  }
}
