import {
  type AuditEvent,
  type AuditLoggerPort,
} from '@/application/platform/ports/audit-logger.port.js';
import { type MetricsPort } from '@/application/platform/ports/metrics.port.js';

/**
 * An audit logger that says out loud when it could not write.
 *
 * A decorator rather than a counter inside `PrismaAuditLogger`, for two reasons that are not style.
 * The writer's job is a row in the caller's transaction, and a metric is not part of that job — the
 * one it wraps is not the only one there will be (`pinoAuditLogger` sits behind it as the unscoped
 * sink, and EPIC-016 adds more), and a decorator counts them all without any of them knowing. It is
 * also what keeps this composable in one line in the composition root instead of a constructor
 * argument threaded through every writer.
 *
 * **It counts and rethrows, and the rethrow is the load-bearing half.** `audit-logger.port.ts` puts
 * the decision about a failed write on the action, and for every action that is not degradable
 * that decision is fail-closed: an action nobody could write down did not happen, so the transaction goes with it.
 * Swallowing the rejection here would turn that into fail-open by way of an improvement in
 * observability — the operation succeeds, the trail has a hole, and a counter ticks where an error
 * used to be. The error is passed on untouched, cause and all.
 *
 * What changes is only who finds out. A broken trail used to reach an operator only as a request
 * that failed, indistinguishable in the RED set from every other failed request; with this, it is a
 * series they can alert on.
 *
 * **Softening happens one layer out, and only there.** `degradingAuditLogger` wraps this decorator
 * and lets a degradable failure (`INFO`, behind no `dangerous` key) through after it was counted here; that is why this one must stay
 * inside — a counter outside it would see only the failures that reached the caller, and the holes
 * in the trail would be exactly the ones it missed.
 */
export const countedAuditLogger = (
  inner: AuditLoggerPort,
  metrics: MetricsPort,
): AuditLoggerPort => ({
  record: async (event: AuditEvent): Promise<void> => {
    try {
      await inner.record(event);
    } catch (error) {
      metrics.incrementAuditWriteFailed();

      throw error;
    }
  },
});
