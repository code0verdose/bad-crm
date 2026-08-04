import { type SharedAudit } from '@bad-crm/shared';

/** Who did it. `userId` is absent for an action taken before any account exists. */
export interface AuditActor {
  readonly userId: string | undefined;
  readonly organizationId: string | undefined;
  readonly ipAddress: string | undefined;
}

/** What it was done to. `id` is absent when the action is about a capability rather than a row. */
export interface AuditTarget {
  readonly type: string;
  readonly id: string | undefined;
}

/**
 * One privileged action, as the trail records it.
 *
 * **`before` and `after` carry identifiers and safe values, never content.** A password, a token, a
 * hash and anything out of the vault are excluded by construction rather than by redaction: the
 * trail is read by whoever can read the log, and a secret that reached it has already leaked. What
 * belongs here is what changed — a status, a role, a name — and enough to find the row.
 */
export interface AuditEvent {
  readonly action: SharedAudit.AuditAction;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly before?: Readonly<Record<string, unknown>>;
  readonly after?: Readonly<Record<string, unknown>>;
  readonly requestId: string | undefined;
}

/**
 * Where a privileged action is written down.
 *
 * A port from the first day, with a pino adapter behind it until EPIC-016 builds the table. The
 * point is the call sites: adding them later means finding every privileged action in a grown
 * codebase and hoping none was missed, and «hoping none was missed» is not a property an audit trail
 * may have.
 *
 * **The moment is stamped by the adapter, not by the caller.** Reading a clock is I/O, and the
 * application layer is the one place in this codebase that may not do it (`rules/hexagonal-backend.mdc`).
 * Handing every privileged use-case a `ClockPort` so it could fill in a field the writer already
 * knows would be four constructor arguments bought for nothing.
 *
 * **`record` may reject, and the caller decides what that means.** For a privileged action the
 * decision is fail-closed — an action nobody could write down did not happen — and that belongs to
 * the use-case that knows whether it is inside a transaction, not to the adapter.
 */
export interface AuditLoggerPort {
  record(event: AuditEvent): Promise<void>;
}
