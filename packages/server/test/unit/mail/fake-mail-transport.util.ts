import {
  type MailTransport,
  type SentMailInfo,
  type TransportMessage,
} from '@/infrastructure/mail/mail-transport.types.js';

/** A nodemailer transport that records what it was handed instead of opening a socket. */
export class FakeMailTransport implements MailTransport {
  readonly sent: TransportMessage[] = [];
  closed = false;

  /** Set to reject the next `sendMail` the way nodemailer does, with a `code` on the error. */
  failure: (Error & { code?: string }) | undefined;

  async sendMail(message: TransportMessage): Promise<SentMailInfo> {
    if (this.failure !== undefined) throw this.failure;

    this.sent.push(message);

    return Promise.resolve({ messageId: `<${this.sent.length}@bad-crm.test>` });
  }

  close(): void {
    this.closed = true;
  }
}

export const smtpError = (code: string, message = 'transport failure'): Error & { code: string } =>
  Object.assign(new Error(message), { code });
