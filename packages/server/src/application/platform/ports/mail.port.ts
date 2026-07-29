/**
 * One outgoing message, already rendered.
 *
 * The port carries a rendered message rather than a template name and a data bag: choosing the
 * language, the wording and the absolute links is a decision of the use-case that owns the
 * operation (EN and RU are equal, `rules/i18n.mdc`), and a transport that renders is a transport
 * that has to know about locales.
 *
 * There is no `from`. The mailbox an installation sends from is `MAIL_FROM` — configuration of the
 * relay the operator runs, not a decision of the operation — and it is applied by the adapter, so a
 * caller cannot omit it.
 */
export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  /** Always present: a mail with an HTML part and no text part is empty in a text client. */
  readonly text: string;
  readonly html?: string;
}

/**
 * Why a message that had a transport still did not go out. A closed set, safe to log and to count.
 *
 * `envelope_rejected` covers both halves of the envelope, because the SMTP client raises one code
 * for them: a sender the relay will not accept and a recipient it will not accept are `EENVELOPE`
 * either way. Naming it after the recipient — which it was — points an operator at the wrong half
 * on the most likely of the two failures.
 */
export type MailFailure = 'connection' | 'authentication' | 'envelope_rejected' | 'unknown';

/**
 * What happened, in three states that the caller must not collapse into two.
 *
 * `not_configured` is **not** a delivery failure. This installation has no `SMTP_URL`, so nothing
 * was attempted and nothing will succeed until an operator acts; the answer is
 * `503 mail_not_configured`, and the catalog in `packages/shared/src/errors/error-code.enums.ts`
 * spells out why that is neither `feature_disabled` (501 — "this product does not do that", and
 * password recovery is not optional) nor a generic `service_unavailable`.
 *
 * `failed` is a transport that exists and did not work — retryable, and the reason belongs in the
 * log, not in the answer to the user.
 *
 * Collapsing the two produces the failure mode STORY-006-08 was written to prevent: a deployment
 * that answers "if the address is registered, a mail has been sent" while it has no way to send
 * anything at all.
 */
export type MailDelivery =
  | { readonly status: 'sent'; readonly messageId: string }
  | { readonly status: 'not_configured' }
  | { readonly status: 'failed'; readonly failure: MailFailure };

/**
 * Sending mail.
 *
 * **`send` is never called inside a database transaction** (`rules/outbox.mdc`, rule 2): SMTP is a
 * slow external call, and holding a connection and its locks open across one turns a mail server's
 * bad day into a database incident. The eventual shape is the `mail` queue fed by the outbox
 * (ADR-0021) — the use-case records the intent in the same transaction as the state change, and a
 * handler calls this port afterwards. Until that queue exists, the same rule holds by hand: build
 * the message inside the transaction, commit, send after.
 *
 * `isConfigured()` is the exception, and the reason it exists as a separate member: it performs no
 * I/O and answers from configuration, so it is safe anywhere — including where it has to be
 * checked, which is **before** an address is resolved. `POST /auth/forgot-password` rests on its
 * answer being identical for a registered address and an unknown one; a 503 raised after the lookup
 * would be exactly the difference between them, and the response would become the account
 * enumeration oracle the 202 was designed not to be (STORY-006-08, and the operation's own
 * description in `docs/api/openapi.yaml`).
 */
export interface MailPort {
  /** Whether this installation has an outgoing transport at all. No I/O, safe inside a transaction. */
  isConfigured(): boolean;
  send(mail: OutgoingMail): Promise<MailDelivery>;
}
