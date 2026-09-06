import { describe, expect, it } from 'vitest';

import {
  AuditFenceRollbackError,
  AuditTrailUnscopedError,
} from '@/application/platform/audit/audit-trail.errors.js';
import {
  type AuditEvent,
  type AuditLoggerPort,
} from '@/application/platform/ports/audit-logger.port.js';
import { type LogFields, type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  AUDIT_WRITE_DEGRADED_EVENT,
  degradingAuditLogger,
} from '@/infrastructure/logging/degrading-audit-logger.adapter.js';

/**
 * What a failed write means to the action that caused it — STORY-016-02, acceptance 9.
 *
 * Two outcomes and nothing in between: a degradable event whose row could not be written is
 * reported and the action goes on; every other one fails the action with it. The decorator is the
 * only place that decides, and the one thing this suite must not let through is a version that
 * softens the second case — that would be fail-open for exactly the actions the trail exists for.
 * Which events are degradable is `isDegradableAuditAction`, proved over the whole catalogue in
 * `degradable-audit-actions.test.ts`; here `session.signed_in` stands for the degradable side and
 * `permission.inspected` for the `INFO` entry that is not.
 */

const info = (): AuditEvent => ({
  action: 'session.signed_in',
  actor: { userId: 'user-1', organizationId: 'org-1', ipAddress: undefined },
  target: { type: 'SESSION', id: 'session-1' },
  after: { deviceLabel: 'laptop' },
  requestId: 'req-info',
});

const warning = (): AuditEvent => ({
  action: 'password.changed',
  actor: { userId: 'user-1', organizationId: 'org-1', ipAddress: undefined },
  target: { type: 'USER', id: 'user-1' },
  requestId: 'req-warning',
});

const critical = (): AuditEvent => ({
  action: 'organization.ownership_transferred',
  actor: { userId: 'user-1', organizationId: 'org-1', ipAddress: undefined },
  target: { type: 'ORGANIZATION', id: 'org-1' },
  requestId: 'req-critical',
});

/** `INFO`, and behind `permission:override_read` — a dangerous key. Quiet, but not degradable. */
const quietButDangerous = (): AuditEvent => ({
  action: 'permission.inspected',
  actor: { userId: 'user-1', organizationId: 'org-1', ipAddress: undefined },
  target: { type: 'USER', id: 'user-2' },
  requestId: 'req-inspected',
});

interface Line {
  readonly level: 'error' | 'warn' | 'info';
  readonly fields: LogFields;
  readonly message: string;
}

const recordingLogger = (): { logger: LoggerPort; lines: Line[] } => {
  const lines: Line[] = [];
  const logger: LoggerPort = {
    debug: () => undefined,
    info: (fields, message) => lines.push({ level: 'info', fields, message }),
    warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
    error: (fields, message) => lines.push({ level: 'error', fields, message }),
    child: () => logger,
  };

  return { logger, lines };
};

const failingWith = (cause: unknown): AuditLoggerPort => ({ record: () => Promise.reject(cause) });

describe('an INFO event whose row could not be written', () => {
  it('lets the action go on, and says so at error level with the action and the failure', async () => {
    const { logger, lines } = recordingLogger();
    const cause = Object.assign(new Error('no partition of relation "audit_logs" found for row'), {
      code: 'P2010',
      meta: { code: '23514' },
    });
    const audit = degradingAuditLogger(failingWith(cause), logger);

    await expect(audit.record(info())).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toStrictEqual({
      level: 'error',
      message: 'audit row could not be written; the action went through without it',
      fields: {
        event: AUDIT_WRITE_DEGRADED_EVENT,
        action: 'session.signed_in',
        severity: 'INFO',
        resourceType: 'SESSION',
        resourceId: 'session-1',
        requestId: 'req-info',
        failure: {
          type: 'Error',
          message: 'no partition of relation "audit_logs" found for row',
          code: 'P2010',
          driverCode: '23514',
        },
      },
    });
  });

  /**
   * The request id the table row would have carried comes from the ambient context when the event
   * has none (`audit-log.adapter.ts`), and so does the logger's own mixin — unless the line writes
   * an explicit `requestId: undefined` on top of it, which the first draft did for the thirteen call
   * sites that pass none. The key is absent, not present-and-empty.
   */
  it('leaves requestId off the line when the event carries none, so the mixin can supply it', async () => {
    const { logger, lines } = recordingLogger();
    const audit = degradingAuditLogger(failingWith(new Error('disk full')), logger);

    await audit.record({ ...info(), requestId: undefined });

    expect(lines[0]?.fields).not.toHaveProperty('requestId');
  });

  /**
   * The other way the payload reaches the line: through the error. A Prisma validation error
   * prints the arguments of the call in its message, `after` included, and the first draft logged
   * the error object whole. The shape is now fixed by construction — type, codes, first line — so
   * this holds for whichever error the store throws next.
   */
  it('reduces the failure to its first line, so an error that dumps the arguments does not', async () => {
    const { logger, lines } = recordingLogger();
    const validationShaped = new Error(
      '\nInvalid `prisma.auditLog.create()` invocation:\n\n{\n  data: {\n    after: { deviceLabel: "laptop" }\n  }\n}',
    );
    validationShaped.name = 'PrismaClientValidationError';
    const audit = degradingAuditLogger(failingWith(validationShaped), logger);

    await audit.record(info());

    expect(lines[0]?.fields).toMatchObject({
      failure: {
        type: 'PrismaClientValidationError',
        message: 'Invalid `prisma.auditLog.create()` invocation:',
      },
    });
    expect(JSON.stringify(lines[0]?.fields)).not.toContain('laptop');
    expect(lines[0]?.fields).not.toHaveProperty('err');
  });

  /**
   * The line reports that a row is missing; it must not become the row. `before`/`after` are the
   * one part of an event that can carry content, and a log line is read by everyone who can read
   * the logs — the reason the adapter redacts before it writes applies here twice over.
   */
  it('does not copy the payload into the log line', async () => {
    const { logger, lines } = recordingLogger();
    const audit = degradingAuditLogger(failingWith(new Error('disk full')), logger);

    await audit.record(info());

    expect(lines[0]?.fields).not.toHaveProperty('after');
    expect(lines[0]?.fields).not.toHaveProperty('before');
    expect(JSON.stringify(lines[0]?.fields)).not.toContain('laptop');
  });

  /**
   * A caller that lost its tenant scope is a bug in the caller, not a failure of the store, and it
   * used to be answered by a log line and a success — the hole `7942a18` closed. Degrading it for
   * INFO actions would reopen exactly that hole for every degradable action in the catalogue.
   */
  it('still refuses an event the adapter could not file at all', async () => {
    const { logger, lines } = recordingLogger();
    const cause = new AuditTrailUnscopedError('session.signed_in', 'it names no organization');
    const audit = degradingAuditLogger(failingWith(cause), logger);

    await expect(audit.record(info())).rejects.toBe(cause);
    expect(lines).toEqual([]);
  });

  /**
   * The insert failed and then the rollback of its savepoint failed too. The premise of degrading
   * — the transaction still accepts a commit — is exactly what is unknown now, so the adapter's own
   * error class goes through untouched, and the caller's commit is what decides.
   */
  it('still refuses an event whose savepoint could not be rolled back', async () => {
    const { logger, lines } = recordingLogger();
    const cause = new AuditFenceRollbackError(
      'session.signed_in',
      new Error('connection reset'),
      new Error('unsupported Unicode escape sequence'),
    );
    const audit = degradingAuditLogger(failingWith(cause), logger);

    await expect(audit.record(info())).rejects.toBe(cause);
    expect(lines).toEqual([]);
  });
});

describe('an event that may not degrade, whose row could not be written', () => {
  it.each([
    ['WARNING', warning()],
    ['CRITICAL', critical()],
    ['INFO behind a dangerous key', quietButDangerous()],
  ])('fails the action with the original cause (%s)', async (_label, event) => {
    const { logger, lines } = recordingLogger();
    const cause = new Error('deadlock detected');
    const audit = degradingAuditLogger(failingWith(cause), logger);

    await expect(audit.record(event)).rejects.toBe(cause);
    // Nothing is logged here: the rejection reaches the error handler, which logs the request that
    // failed. A second line for the same failure is the duplicate `rules/observability.mdc` forbids.
    expect(lines).toEqual([]);
  });
});

describe('CONTROL: a write that succeeded', () => {
  it('is passed through untouched and produces no line', async () => {
    const { logger, lines } = recordingLogger();
    const written: AuditEvent[] = [];
    const audit = degradingAuditLogger(
      {
        record: (event) => {
          written.push(event);

          return Promise.resolve();
        },
      },
      logger,
    );

    await audit.record(info());
    await audit.record(warning());

    expect(written).toEqual([info(), warning()]);
    expect(lines).toEqual([]);
  });
});
