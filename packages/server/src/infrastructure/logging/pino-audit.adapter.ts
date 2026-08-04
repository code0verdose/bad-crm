import {
  type AuditEvent,
  type AuditLoggerPort,
} from '@/application/platform/ports/audit-logger.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';

/** The field a query filters the trail by, until EPIC-016 gives it a table of its own. */
export const AUDIT_MARKER = 'audit';

/**
 * The audit trail as log lines, which is what an installation has until the table exists.
 *
 * `audit: true` is the whole interface for a reader: one filter separates the trail from the traffic
 * around it, and the same field is what a shipper routes into a longer-retention bucket. Written at
 * `info` rather than `warn`, because a privileged action is not a problem — it is the record that
 * one happened.
 *
 * The event is spread into **fields**, never into the message. The message is a constant so a search
 * groups the trail, and `before`/`after` are values that must not become part of a format string.
 */
export const pinoAuditLogger = (logger: LoggerPort, clock: ClockPort): AuditLoggerPort => ({
  record: (event: AuditEvent): Promise<void> => {
    logger.info(
      {
        [AUDIT_MARKER]: true,
        action: event.action,
        actorUserId: event.actor.userId,
        actorOrganizationId: event.actor.organizationId,
        actorIpAddress: event.actor.ipAddress,
        targetType: event.target.type,
        targetId: event.target.id,
        occurredAt: clock.now().toISOString(),
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        ...(event.before === undefined ? {} : { before: event.before }),
        ...(event.after === undefined ? {} : { after: event.after }),
      },
      'audit',
    );

    return Promise.resolve();
  },
});
