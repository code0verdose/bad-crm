import { type SharedAudit } from '@bad-crm/shared';

/** Who did it. `userId` is absent for an action taken before any account exists. */
export interface AuditActor {
  readonly userId: string | undefined;
  readonly organizationId: string | undefined;
  readonly ipAddress: string | undefined;
}

/**
 * What it was done to. `id` is absent when the action is about a capability rather than a row.
 *
 * `type` comes from the closed vocabulary in `packages/shared`: it is what a reader of the trail
 * filters by, and a second spelling of the same kind of object — `user` beside `USER` — is a filter
 * that silently returns half the history.
 */
export interface AuditTarget {
  readonly type: SharedAudit.AuditResourceType;
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
 * A port from the first day, with a pino adapter behind it until STORY-016-01 built the table (2026-08-05). The
 * point is the call sites: adding them later means finding every privileged action in a grown
 * codebase and hoping none was missed, and «hoping none was missed» is not a property an audit trail
 * may have.
 *
 * **The moment is stamped by the adapter, not by the caller.** Reading a clock is I/O, and the
 * application layer is the one place in this codebase that may not do it (`rules/hexagonal-backend.mdc`).
 * Handing every privileged use-case a `ClockPort` so it could fill in a field the writer already
 * knows would be four constructor arguments bought for nothing.
 *
 * **`record` may reject, and what that means is decided by the action, not by the caller.** A
 * `WARNING` or `CRITICAL` event that could not be written rejects, and so does an `INFO` one that
 * records the exercise of a key the permission catalogue marks dangerous (`permission.inspected`
 * behind `permission:override_read`); the use-case that awaited it fails with its transaction — an
 * action nobody could write down did not happen. Any other `INFO` event that could not be written
 * resolves: the failure is counted, reported at `error`, and the action goes on without its row
 * (STORY-016-02, acceptance 9). The line between the two is
 * `application/platform/audit/degradable-audit-actions.util.ts`, drawn from `AUDIT_ACTION_SEVERITY`
 * and `AUDIT_ACTION_PERMISSIONS` together; the decision is made in the decorator the composition
 * root wraps every writer in (`degrading-audit-logger.adapter.ts`), so a use-case simply awaits and
 * never chooses.
 *
 * **Two `record` calls on one transaction are safe to start together; a `record` and the caller's
 * own statement are not.** The writer serialises its own calls per transaction, so racing two
 * records cannot lose a row. It cannot serialise the caller: a degradable row is fenced in a
 * savepoint, and a statement the use-case started concurrently with `record` — instead of before
 * or after it — would be undone by that fence's rollback with nothing reporting it. Await `record`
 * in sequence with the change it describes.
 *
 * **Recording outside the tenant scope of the change is one of the ways it rejects.** The row lives
 * in a tenant table, so an event that names no organization, or one the open scope disagrees with,
 * cannot be filed — and answering that with a log line would hand the caller a success while its
 * privileged action went unrecorded. Only the actions on `AUDIT_ACTIONS_WITHOUT_ORGANIZATION`
 * (`application/platform/audit/unscoped-audit-actions.constant.ts`) have no organization by nature
 * and take that path; for everything else, record inside the `withTenant` block of the change being
 * described, which is where `rules/observability.mdc` §15 asks for it anyway.
 */
export interface AuditLoggerPort {
  record(event: AuditEvent): Promise<void>;
}
