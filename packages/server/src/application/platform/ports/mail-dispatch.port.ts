import { type OutgoingMail } from '@/application/platform/ports/mail.port.js';
import { type SecurityEvent } from '@/domain/identity/security-event.constant.js';

/**
 * What the log is allowed to say about a message that was handed over.
 *
 * Identifiers and the name of the operation, and nothing that came out of the message: not the
 * recipient, not the subject, not a single character of the body. The one mail this epic sends
 * carries a single-use reset token inside a link, and `rules/observability.mdc` puts the body of a
 * request and of a mail in the same category for the same reason.
 */
export interface MailDispatchContext {
  readonly event: SecurityEvent;
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * Handing a rendered message over for delivery, and returning immediately.
 *
 * ## Why this exists rather than a call to `MailPort.send`
 *
 * Two properties of `POST /auth/forgot-password` are impossible to hold while the use-case awaits
 * an SMTP round trip, and both are acceptance criteria rather than preferences:
 *
 * 1. **The answer must not depend on whether the address is registered — including in its timing.**
 *    A registered address costs a connection to a relay and a `DATA` command; an unknown one costs
 *    nothing. Awaited, that difference is tens to hundreds of milliseconds, which is a script's
 *    first measurement and a directory of everybody with an account on the installation.
 * 2. **No external call inside a database transaction** (`rules/outbox.mdc`, rule 2). Awaiting the
 *    send after the commit satisfies that one; it does not satisfy the first.
 *
 * ## The compromise this interface *is*, stated plainly
 *
 * The design of record is the transactional outbox with a BullMQ `mail` queue (ADR-0021,
 * `docs/architecture/stack.md` → «Фоновые задачи и outbox»): the use-case records the intent in the
 * same transaction as the state change, a dispatcher picks it up, a handler retries with backoff and
 * a message that exhausts its attempts lands in `dead_letter` where an operator can see it. **None
 * of that exists yet** — there is no `outbox_event` table, no queue and no worker, and building one
 * is its own epic.
 *
 * So this port is the smallest honest stand-in: delivery is attempted in this process, immediately,
 * once. What is deliberately given up until the queue lands, and must not be forgotten when it does:
 *
 * - **No retry.** A relay that is down for a minute loses the message. The person asks again.
 * - **No durability.** A process that exits between `dispatch` and delivery loses the message; the
 *   reset row is already committed, so the token simply expires unused after its hour.
 * - **No visibility beyond the log.** There is no dead-letter queue an administrator can inspect,
 *   which is why the adapter writes a line for every outcome including the failures.
 *
 * What is **not** given up, and is the reason this is acceptable in the meantime: the state change
 * is committed before anything is handed over, so a failed delivery never rolls back a password;
 * the transaction is closed before the socket is opened; and nothing about the recipient reaches the
 * response or the log. Replacing this adapter with an outbox handler changes no use-case — they
 * call `dispatch` and are done, which is exactly what they would do with a queue behind it.
 */
export interface MailDispatchPort {
  /**
   * Takes the message and returns at once. **Never throws and never rejects**: a notification that
   * could not be sent must not undo the operation that produced it, and the caller has already
   * committed by the time this runs.
   */
  dispatch(mail: OutgoingMail, context: MailDispatchContext): void;

  /**
   * Waits for everything already handed over.
   *
   * Two callers, and both are the reason it is on the port rather than on the adapter: graceful
   * shutdown, which would otherwise close the process with messages still in flight, and the
   * integration suite, which has to know when there is something to look for in Mailpit.
   */
  drain(): Promise<void>;
}
