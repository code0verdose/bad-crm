import { SharedAudit } from '@bad-crm/shared';

import {
  AuditFenceRollbackError,
  AuditTrailUnscopedError,
} from '@/application/platform/audit/audit-trail.errors.js';
import { isDegradableAuditAction } from '@/application/platform/audit/degradable-audit-actions.util.js';
import {
  type AuditEvent,
  type AuditLoggerPort,
} from '@/application/platform/ports/audit-logger.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { describeAuditWriteFailure } from '@/infrastructure/logging/audit-write-failure.util.js';

/** The `event` field of the line that says a row is missing, so a search finds every such line. */
export const AUDIT_WRITE_DEGRADED_EVENT = 'audit.write_degraded';

/**
 * The one place that decides what a failed write means to the action that caused it.
 *
 * STORY-016-02, acceptance 9: an event whose row could not be written is reported and the action
 * goes on if the action may degrade, and fails the action with it if it may not. Which is which is
 * `isDegradableAuditAction` — severity `INFO` and no dangerous key behind the action — decided by
 * the action and not here.
 *
 * **What is softened is everything the degradable path throws, not «database errors».** The
 * decorator cannot tell a refused insert from a programming error raised on the way to it — a
 * redaction walk that threw, a hasher handed a malformed address, a `TypeError` in the adapter —
 * and does not try: for a degradable action any of those becomes a line at `error` and the action
 * goes on. That is deliberate. The alternative, softening only errors that look like the
 * database's, would turn a bug in the writer into a failed sign-in for every user until somebody
 * fixed it, and the line is the same line either way. Two exceptions, both because the premise
 * «the action can go on without its row» no longer holds: `AuditTrailUnscopedError` (below) and
 * `AuditFenceRollbackError` — the savepoint could not be rolled back, so the transaction is not
 * known to accept a commit, and «the action went through» would be a claim about a commit that
 * may be refused. Both are rethrown for every severity.
 *
 * **A decorator outside `countedAuditLogger`, and the order is load-bearing.** The counter sits
 * inside, so it sees the failure before this layer decides whether anyone else does — a degraded
 * write is still a write that failed, and `audit_write_failed_total` is the number the alert is on.
 * Put the other way round, the counter would see only the failures that reached the caller, and the
 * holes in the trail would be exactly the ones it did not count. The order as the process wires it
 * is asserted in `test/unit/bootstrap/audit-wiring.test.ts`, through the container and not through
 * a chain the test built.
 *
 * **It relies on the adapter having fenced the insert.** A failed statement leaves a PostgreSQL
 * transaction aborted, so swallowing the error here would let the use-case run on into a `COMMIT`
 * that refuses it — a success reported to the caller and contradicted by the database. The adapter
 * puts a degradable insert inside a savepoint and rolls back to it on failure
 * (`audit-log.adapter.ts`), which is what makes the swallow here honest; the pair is proved together
 * in `test/integration/db/audit-write-degradation.test.ts`.
 *
 * **`AuditTrailUnscopedError` is never softened, whatever the severity.** It is a bug in the caller
 * — an event recorded outside the tenant scope of its change — and not a failure of the store, and
 * it used to be answered with a log line and a success before `7942a18` made it a refusal.
 * Degrading it for the part of the catalogue that may degrade would reopen that hole.
 *
 * **The line is at `error`, with the failure reduced to its type, codes and first line, and without
 * the payload.** `error` because a hole in the trail is what `rules/observability.mdc` §7 means by
 * «requires a person»; without `before`/`after` because a line reporting a missing row must not
 * become the row — it is read by everyone who can read the logs; and the failure reduced
 * (`audit-write-failure.util.ts`) because the error object is the other way the payload reaches
 * the line — a Prisma validation error prints the arguments of the call. `requestId` is written
 * only when the event carries one; otherwise the logger's own mixin supplies the request's id from
 * the ambient context, the same source the table row takes it from, and an explicit `undefined`
 * would have overridden it with nothing. Nothing is logged for the fail-closed case: the rejection
 * reaches the error handler with the request that failed, and a second line would be the same
 * failure twice.
 */
export const degradingAuditLogger = (
  inner: AuditLoggerPort,
  logger: LoggerPort,
): AuditLoggerPort => ({
  record: async (event: AuditEvent): Promise<void> => {
    try {
      await inner.record(event);
    } catch (error) {
      if (
        error instanceof AuditTrailUnscopedError ||
        error instanceof AuditFenceRollbackError ||
        !isDegradableAuditAction(event.action)
      ) {
        throw error;
      }

      logger.error(
        {
          event: AUDIT_WRITE_DEGRADED_EVENT,
          action: event.action,
          severity: SharedAudit.severityOf(event.action),
          resourceType: event.target.type,
          resourceId: event.target.id,
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
          failure: describeAuditWriteFailure(error),
        },
        'audit row could not be written; the action went through without it',
      );
    }
  },
});
