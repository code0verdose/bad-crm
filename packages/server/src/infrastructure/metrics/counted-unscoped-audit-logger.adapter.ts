import {
  type AuditEvent,
  type AuditLoggerPort,
} from '@/application/platform/ports/audit-logger.port.js';
import { type MetricsPort } from '@/application/platform/ports/metrics.port.js';

/**
 * The sink for events that have no organization, with a number attached.
 *
 * A second decorator beside `countedAuditLogger` rather than a branch inside it, because they count
 * two different things and only one of them is a failure. `countedAuditLogger` wraps the whole trail
 * and counts what it could not write; this one wraps the log sink underneath and counts what took
 * that path on purpose — a privileged action recorded outside the table because
 * `audit_logs.organization_id` is `NOT NULL` and the action has no organization by nature
 * (`application/platform/audit/unscoped-audit-actions.constant.ts`).
 *
 * Wrapping the sink rather than teaching `PrismaAuditLogger` about metrics keeps the writer's job
 * what it was — a row in the caller's transaction — and keeps this composable in one line in the
 * composition root. It also means the number is right by construction: the only way to reach the
 * sink is through here.
 *
 * **It counts and rethrows.** The log sink can fail too, and a failure of it is still a failure of
 * the trail; swallowing it here would make the last remaining channel silent.
 */
export const countedUnscopedAuditLogger = (
  inner: AuditLoggerPort,
  metrics: MetricsPort,
): AuditLoggerPort => ({
  record: async (event: AuditEvent): Promise<void> => {
    await inner.record(event);
    metrics.incrementAuditUnscoped();
  },
});
