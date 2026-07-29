/**
 * One message as nodemailer takes it. A subset: this product sends no attachments and no headers.
 *
 * `from` is **required**, and it is the point of this declaration. Mailpit accepts a message without
 * an envelope sender, so an integration suite stays green while Postfix, SES and every relay that
 * checks the envelope answer 5.x — a defect no test could see and every real installation would.
 * Required here means the compiler catches a message built without one.
 */
export interface TransportMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface SentMailInfo {
  readonly messageId: string;
}

/**
 * The slice of a nodemailer `Transporter` the adapter uses.
 *
 * Declared so that the adapter's own behaviour — the failure taxonomy, and the guarantee that
 * nothing from the message reaches a log — is unit-testable without an SMTP server, while the
 * transport itself is exercised against a real one in `test/integration/mail/**`. The real
 * `Transporter` satisfies this as it stands; there is no wrapper.
 */
export interface MailTransport {
  sendMail(message: TransportMessage): Promise<SentMailInfo>;
  close(): void;
}
