import { describe, expect, it } from 'vitest';

import { SharedAudit } from '@bad-crm/shared';

import { type LogFields, type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { AUDIT_MARKER, pinoAuditLogger } from '@/infrastructure/logging/pino-audit.adapter.js';

const OCCURRED_AT = new Date('2026-08-04T10:00:00.000Z');
const fixedClock = { now: () => OCCURRED_AT };

const recordingLogger = (): {
  logger: LoggerPort;
  lines: { fields: LogFields; message: string }[];
} => {
  const lines: { fields: LogFields; message: string }[] = [];
  const logger: LoggerPort = {
    debug: () => undefined,
    info: (fields, message) => lines.push({ fields, message }),
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };

  return { logger, lines };
};

describe('the audit trail as log lines', () => {
  it('marks the line so one filter separates the trail from the traffic', async () => {
    const { logger, lines } = recordingLogger();

    await pinoAuditLogger(logger, fixedClock).record({
      action: 'session.signed_in',
      actor: { userId: 'user-1', organizationId: 'org-1', ipAddress: '203.0.113.4' },
      target: { type: 'SESSION', id: 'session-9' },
      requestId: 'req-3',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({
      [AUDIT_MARKER]: true,
      action: 'session.signed_in',
      actorUserId: 'user-1',
      actorOrganizationId: 'org-1',
      targetType: 'SESSION',
      targetId: 'session-9',
      requestId: 'req-3',
      occurredAt: '2026-08-04T10:00:00.000Z',
    });
  });

  /**
   * The message is a constant so a search groups the trail; the event travels as fields. An event
   * interpolated into the message would also put `before`/`after` into a format string.
   */
  it('puts the event in fields, not in the message', async () => {
    const { logger, lines } = recordingLogger();

    await pinoAuditLogger(logger, fixedClock).record({
      action: 'password.changed',
      actor: { userId: 'user-1', organizationId: 'org-1', ipAddress: undefined },
      target: { type: 'USER', id: 'user-1' },
      requestId: undefined,
    });

    expect(lines[0]?.message).toBe('audit');
    expect(lines[0]?.fields).not.toHaveProperty('requestId');
  });

  it('carries the before and after state when there is one', async () => {
    const { logger, lines } = recordingLogger();

    await pinoAuditLogger(logger, fixedClock).record({
      action: 'organization.registered',
      actor: { userId: 'user-1', organizationId: 'org-1', ipAddress: undefined },
      target: { type: 'ORGANIZATION', id: 'org-1' },
      after: { slug: 'acme', status: 'active' },
      requestId: undefined,
    });

    expect(lines[0]?.fields).toMatchObject({ after: { slug: 'acme', status: 'active' } });
    expect(lines[0]?.fields).not.toHaveProperty('before');
  });
});

/**
 * The catalogue is closed on purpose: an action named at a call site is one nobody reviewed, and a
 * typo opens a second name for the same event that every filter over the trail then misses.
 */
describe('the action catalogue', () => {
  it('covers the privileged actions implemented so far', () => {
    expect([...SharedAudit.AUDIT_ACTIONS]).toEqual([
      'organization.registered',
      'session.signed_in',
      'session.revoked',
      'password.changed',
      'password.reset',
      'role.created',
      'role.updated',
      'role.deleted',
      'role.dangerous_granted',
      'role.assigned',
      'role.revoked',
      'permission.override.created',
      'permission.override.updated',
      'permission.override.deleted',
      'rls.bypassed',
    ]);
  });

  /**
   * Every action has a severity, and the severity belongs to the action rather than to the caller:
   * the same event filed at two levels by two use-cases makes «show me the critical ones» silently
   * incomplete. The type already enforces completeness — this says so at runtime, and fails when a
   * level is `undefined` because a map lost an entry in a merge.
   */
  it.each([...SharedAudit.AUDIT_ACTIONS])('files %s at a known severity', (action) => {
    expect(SharedAudit.AUDIT_SEVERITIES).toContain(SharedAudit.severityOf(action));
  });

  it.each([...SharedAudit.AUDIT_ACTIONS])('recognises %s', (action) => {
    expect(SharedAudit.isAuditAction(action)).toBe(true);
  });

  it('CONTROL: refuses a name that is not in the list', () => {
    expect(SharedAudit.isAuditAction('session.almost_signed_in')).toBe(false);
  });
});
