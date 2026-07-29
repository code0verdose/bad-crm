import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  type MailDispatchContext,
  type MailDispatchPort,
} from '@/application/platform/ports/mail-dispatch.port.js';
import { type MailPort, type OutgoingMail } from '@/application/platform/ports/mail.port.js';

/** The class of a thrown value, or its primitive type when it is not an `Error` at all. */
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/**
 * `MailDispatchPort` without a queue: the message is sent from this process, immediately, once.
 *
 * ## The compromise, and where it is recorded
 *
 * `rules/outbox.mdc` asks for the intent to be written to `outbox_event` inside the transaction and
 * for a BullMQ handler to do the sending (ADR-0021). Neither the table nor the queue exists yet, and
 * building them is an epic of its own — so this is the smallest adapter that keeps the two
 * properties the operations actually depend on and gives up only what a queue would have added:
 *
 * - **kept** — nothing external runs inside a transaction: the caller commits first and hands the
 *   message over afterwards, and `dispatch` returns before a socket is opened;
 * - **kept** — the answer to `POST /auth/forgot-password` does not wait for a relay, so its timing
 *   does not depend on whether the address was registered;
 * - **given up** — retries, durability across a restart, and a dead-letter queue an administrator
 *   can look at. A relay that is down loses the message; the person asks again, and the reset row
 *   they already have simply expires after its hour.
 *
 * The full statement of the trade lives on the port. Replacing this class with an outbox handler
 * changes no use-case.
 *
 * ## Why it never throws
 *
 * `dispatch` is called after the state change has committed. A rejection here would either be an
 * unhandled rejection — which takes the process down with it under Node's default — or would have to
 * be caught by every caller into the same `catch` block written five times. So the failure is
 * absorbed and *recorded*: with no dead-letter queue, this log line is the only place an operator
 * can see that a message did not leave.
 *
 * ## What the line contains
 *
 * The event, the identifiers and the delivery status. **Not the recipient, not the subject and not
 * one character of the body** — the mail of this epic carries a single-use reset token inside a
 * link, and a log is the least private place in a deployment (`rules/observability.mdc`, CLAUDE.md
 * «Что нельзя логировать никогда»). `NodemailerMailAdapter` holds the same rule on its own side, so
 * neither half depends on the other having remembered it.
 *
 * **Nor the thrown value**, on the branch that catches one: the message of an SMTP error is written
 * by the remote relay and quotes the envelope it refused. Only its class is kept — see the comment
 * on that `catch`, which also records why the suite could not see the difference.
 */
export class ImmediateMailDispatcher implements MailDispatchPort {
  /** Handed-over messages that have not finished. Emptied by the promise that put them there. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly mail: MailPort,
    private readonly logger: LoggerPort,
  ) {}

  dispatch(mail: OutgoingMail, context: MailDispatchContext): void {
    const task = this.deliver(mail, context);

    this.inFlight.add(task);
    // `deliver` never rejects, so this is a completion hook rather than a swallowed failure.
    void task.finally(() => this.inFlight.delete(task));
  }

  /**
   * Waits for what has already been handed over — and waits for what those messages start, which is
   * why the set is re-read rather than snapshotted once.
   */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private async deliver(mail: OutgoingMail, context: MailDispatchContext): Promise<void> {
    try {
      const delivery = await this.mail.send(mail);

      if (delivery.status === 'sent') {
        this.logger.info({ ...context, delivery: 'sent' }, 'mail delivered');

        return;
      }

      // `not_configured` is a **documented degradation**, not a failure: `SMTP_URL` is optional in
      // the `minimal` profile, and `POST /auth/change-password` deliberately proceeds without a
      // transport rather than refusing a recovery action over an undelivered notice. It used to be
      // recorded at `error` on the reasoning that every caller checks `isConfigured()` first — true
      // only while the sole caller was the one that answers 503. On a minimal installation this
      // branch is now reached by every password change, and an error per password change is an
      // alert somebody mutes, which is how the `failed` line below stops being read too.
      //
      // `warn` is what the level means: a degradation the system handled
      // (`rules/observability.mdc`, rule 7). The message names the one actionable half.
      if (delivery.status === 'not_configured') {
        this.logger.warn(
          { ...context, delivery: 'not_configured' },
          'notification not sent: this installation has no SMTP_URL',
        );

        return;
      }

      this.logger.error(
        { ...context, delivery: 'failed', failure: delivery.failure },
        'mail was not delivered',
      );
    } catch (error) {
      // The thrown value itself is deliberately **not** a field.
      //
      // It used to be, as `err`, and it was invisible: an `Error` has no enumerable properties, so
      // every "no recipient reached the log" assertion in the suite serialized it to `{}` and passed
      // over it. pino does not — its `err` serializer writes `message` and `stack` — and the message
      // of an SMTP error is composed by the remote relay, which quotes the envelope straight back:
      // `550 5.1.1 <ada@example.com>: Recipient address rejected`. `NodemailerMailAdapter` never
      // hands one over, because it catches its own failures and returns them classified; the second
      // adapter is the one that would, and by then this line would be the leak.
      //
      // The class of the thrown value is kept, because it is bounded and it is the actionable half:
      // reaching this branch at all means an adapter broke the contract of `MailPort.send`, which
      // returns failures and does not throw them.
      this.logger.error(
        { ...context, delivery: 'failed', errorName: nameOf(error) },
        'mail dispatch raised; the transport adapter threw instead of reporting a failure',
      );
    }
  }
}
