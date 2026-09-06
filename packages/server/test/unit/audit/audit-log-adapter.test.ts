import { type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { AuditFenceRollbackError } from '@/application/platform/audit/audit-trail.errors.js';
import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { PrismaAuditLogger } from '@/infrastructure/persistence/prisma/audit-log.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Which events become rows, and what the row says — decided without a database.
 *
 * The transaction semantics are proved against a real PostgreSQL
 * (`test/integration/db/audit-trail-writes.test.ts`, by rolling one back); what is checked here is
 * the branching, which is where the failures are silent: an event filed under the wrong tenant, an
 * address stored instead of its digest, a severity taken from the caller. A fake transaction is
 * enough for all three, and it is the only way to see the values the adapter actually passes.
 */

const ORG = '00000000-0000-4000-8000-000000000c01';

const requestContext: RequestContextPort = {
  current: () => ({ requestId: 'ambient', organizationId: null, userId: null }),
  run: (_context, fn) => fn(),
  identify: () => undefined,
};

/**
 * A client whose `$transaction` runs the callback against a stub. `withTenant` needs exactly two
 * things from it — a transaction and `$executeRaw` for the two `set_config` calls — so the double
 * is small enough to read and real enough to put the adapter inside a tenant scope.
 */
const fakeClient = (
  create: ReturnType<typeof vi.fn>,
  statements: string[] = [],
  failing: (statement: string) => Error | undefined = () => undefined,
): PrismaClient => {
  const tx = {
    // Records every raw statement as its text, so a suite can see what the adapter said to the
    // transaction around the insert — and, as important, what it did not say. A `Prisma.raw`
    // fragment is spelled out (the savepoint name is one); a bound parameter stays a `?`.
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.reduce(
        (text, part, index) => text + part + (index < values.length ? spell(values[index]) : ''),
        '',
      );

      statements.push(statement);

      const failure = failing(statement);

      return failure === undefined ? Promise.resolve(0) : Promise.reject(failure);
    },
    auditLog: { create },
  };

  return {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
};

const spell = (value: unknown): string =>
  typeof value === 'object' && value !== null && 'sql' in value ? String(value.sql) : '?';

/** Lets the suite hold an insert open, so a second record can be observed queueing behind it. */
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

const flush = (): Promise<void> => new Promise((settle) => setImmediate(settle));

/** The statements of `withTenant` itself, which every arm below issues and none is about. */
const TENANT_STATEMENTS = 2;

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  action: 'password.changed',
  actor: { userId: 'user-1', organizationId: ORG, ipAddress: '203.0.113.9' },
  target: { type: 'USER', id: 'user-1' },
  requestId: undefined,
  ...overrides,
});

type RecordFn = (event: AuditEvent) => Promise<void>;

const loggerFor = (unscoped: RecordFn): PrismaAuditLogger =>
  new PrismaAuditLogger({
    addressHasher: { hash: (address) => `digest:${address ?? 'none'}` },
    requestContext,
    unscoped: { record: unscoped },
  });

describe('an event that can be a row', () => {
  it('writes it with the severity of the action, a hashed address and the ambient request id', async () => {
    const create = vi.fn().mockResolvedValue({});
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(event({ after: { revokedFamilies: 1 } }));
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        actorId: 'user-1',
        actorType: 'USER',
        action: 'password.changed',
        resourceType: 'USER',
        resourceId: 'user-1',
        after: { revokedFamilies: 1 },
        ipHash: 'digest:203.0.113.9',
        requestId: 'ambient',
        severity: 'WARNING',
      }),
    });
    expect(unscoped).not.toHaveBeenCalled();
  });

  it('calls an event with no acting person a SYSTEM one', async () => {
    const create = vi.fn().mockResolvedValue({});
    const logger = loggerFor(() => Promise.resolve());

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(
        event({ actor: { userId: undefined, organizationId: ORG, ipAddress: undefined } }),
      );
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { actorType: 'SYSTEM', actorId: null, ipHash: null },
    });
  });

  it('prefers the request id the caller passed over the ambient one', async () => {
    const create = vi.fn().mockResolvedValue({});
    const logger = loggerFor(() => Promise.resolve());

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(event({ requestId: 'explicit' }));
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({ data: { requestId: 'explicit' } });
  });
});

/**
 * The guard in front of the trail, at the one place both channels pass through.
 *
 * It lives here rather than in each use-case for the reason the port's own comment gives: a rule
 * every caller has to remember is a rule that holds until one of them does not. The unscoped branch
 * matters as much as the row: an event of an organization that is not yet known goes to the log, and
 * a log line is read by everyone with access to the logs.
 */
describe('a payload carrying something it should not', () => {
  it('cuts it out of the row and records that it was cut', async () => {
    const create = vi.fn().mockResolvedValue({});
    const logger = loggerFor(() => Promise.resolve());

    await withTenant(fakeClient(create), { organizationId: ORG, userId: null }, async () => {
      await logger.record(event({ after: { roleId: 'role-1', apiKey: 'sk-live-1' } }));
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { after: { roleId: 'role-1', apiKey: '[redacted]', _redacted: ['apiKey'] } },
    });
  });

  it('cuts it out of the event that goes to the log instead', async () => {
    const unscoped = vi.fn<RecordFn>().mockResolvedValue(undefined);
    const logger = loggerFor(unscoped);

    // One of the actions that may be recorded without an organization, because those are the only
    // ones the log sink still receives (`unscoped-audit-actions.constant.ts`).
    await logger.record(
      event({
        action: 'rls.bypassed',
        actor: { userId: undefined, organizationId: undefined, ipAddress: undefined },
        before: { password: 'hunter2' },
      }),
    );

    expect(unscoped.mock.calls[0]?.[0].before).toStrictEqual({
      password: '[redacted]',
      _redacted: ['password'],
    });
  });
});

/**
 * How the insert is fenced inside the caller's transaction — STORY-016-02, acceptance 9.
 *
 * A failed statement puts a PostgreSQL transaction into the aborted state, and every statement after
 * it — the caller's own commit included — is refused with `25P02`. So «the INFO row failed and the
 * action went on» is only true if the insert ran inside a savepoint that is rolled back on failure;
 * without one, a decorator that swallows the error hands the caller a success its commit will
 * contradict. The savepoint is bought only for the actions that may degrade: for a WARNING or a
 * CRITICAL the aborted transaction is the fail-closed outcome the trail wants, and two round trips
 * for nothing is what the cost test would then be measuring. The two halves are proved together
 * against a real database in `test/integration/db/audit-write-degradation.test.ts`; what is checked
 * here is which statements the adapter issues, and in what order.
 */
describe('the fence around the insert', () => {
  it('wraps an INFO insert in a savepoint and releases it after a successful write', async () => {
    const create = vi.fn().mockResolvedValue({});
    const statements: string[] = [];
    const logger = loggerFor(() => Promise.resolve());

    await withTenant(
      fakeClient(create, statements),
      { organizationId: ORG, userId: null },
      async () => {
        await logger.record(
          event({ action: 'session.signed_in', target: { type: 'SESSION', id: undefined } }),
        );
      },
    );

    expect(statements.slice(TENANT_STATEMENTS)).toEqual([
      'SAVEPOINT audit_entry_1',
      'RELEASE SAVEPOINT audit_entry_1',
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rolls an INFO insert back to the savepoint when it fails, and still rejects', async () => {
    const cause = new Error('invalid input syntax for type uuid');
    const create = vi.fn().mockRejectedValue(cause);
    const statements: string[] = [];
    const logger = loggerFor(() => Promise.resolve());

    await withTenant(
      fakeClient(create, statements),
      { organizationId: ORG, userId: null },
      async () => {
        await expect(
          logger.record(
            event({ action: 'session.signed_in', target: { type: 'SESSION', id: undefined } }),
          ),
        ).rejects.toBe(cause);
      },
    );

    // Rolled back, not released: the writer restores the transaction and reports the failure; who
    // softens it is decided one layer up (`degrading-audit-logger.adapter.ts`), never here.
    expect(statements.slice(TENANT_STATEMENTS)).toEqual([
      'SAVEPOINT audit_entry_1',
      'ROLLBACK TO SAVEPOINT audit_entry_1',
    ]);
  });

  it.each(['password.changed', 'organization.ownership_transferred'] as const)(
    'issues no savepoint around a %s insert, so a failure aborts the transaction',
    async (action) => {
      const create = vi.fn().mockResolvedValue({});
      const statements: string[] = [];
      const logger = loggerFor(() => Promise.resolve());

      await withTenant(
        fakeClient(create, statements),
        { organizationId: ORG, userId: null },
        async () => {
          await logger.record(event({ action }));
        },
      );

      expect(statements.slice(TENANT_STATEMENTS)).toEqual([]);
      expect(create).toHaveBeenCalledTimes(1);
    },
  );
});

/**
 * Two records in one transaction, and what the fence has to survive.
 *
 * A savepoint is a point on one connection's stack, and `ROLLBACK TO` undoes everything after it —
 * not only the statement it was set for. Two `record` calls started together (`Promise.all`) on
 * one transaction would put both savepoints on the stack before either insert ran; the rollback of
 * the second then erased the first's row while the first reported success, and the counter never
 * saw it. Nothing in the tree races two records today, and that is exactly the kind of fact a
 * docstring cannot hold: the adapter serialises records per transaction so the fence and the insert
 * of one entry are contiguous on the wire, and every fence carries its own name so a rollback can
 * only ever address the point it set. Both are asserted on the statement list; the row surviving is
 * proved on PostgreSQL in `audit-write-degradation.test.ts`.
 */
describe('two records in one transaction', () => {
  it('runs them one after the other, each under a savepoint of its own', async () => {
    const firstInsert = deferred<unknown>();
    const cause = new Error('unsupported Unicode escape sequence');
    const create = vi
      .fn()
      .mockImplementationOnce(() => firstInsert.promise)
      .mockRejectedValueOnce(cause);
    const statements: string[] = [];
    const logger = loggerFor(() => Promise.resolve());
    const infoEvent = (requestId: string): AuditEvent =>
      event({ action: 'session.signed_in', target: { type: 'SESSION', id: undefined }, requestId });

    await withTenant(
      fakeClient(create, statements),
      { organizationId: ORG, userId: null },
      async () => {
        const first = logger.record(infoEvent('first'));
        const second = logger.record(infoEvent('second')).then(
          () => 'resolved',
          (error: unknown) => error,
        );

        await flush();

        // The first insert is still open, and the second record has said nothing to the
        // transaction yet: its fence waits for the first to close.
        expect(statements.slice(TENANT_STATEMENTS)).toEqual(['SAVEPOINT audit_entry_1']);
        expect(create).toHaveBeenCalledTimes(1);

        firstInsert.resolve({});

        await first;
        expect(await second).toBe(cause);
      },
    );

    expect(statements.slice(TENANT_STATEMENTS)).toEqual([
      'SAVEPOINT audit_entry_1',
      'RELEASE SAVEPOINT audit_entry_1',
      'SAVEPOINT audit_entry_2',
      'ROLLBACK TO SAVEPOINT audit_entry_2',
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  /**
   * The name is built from the adapter's own counter and nothing the caller supplied — the one
   * place this file interpolates into SQL — and the counter does not restart per transaction, so
   * two records in two transactions cannot share a point either.
   */
  it('never reuses a savepoint name across transactions', async () => {
    const create = vi.fn().mockResolvedValue({});
    const statements: string[] = [];
    const logger = loggerFor(() => Promise.resolve());
    const infoEvent = event({
      action: 'session.signed_in',
      target: { type: 'SESSION', id: undefined },
    });

    await withTenant(fakeClient(create, statements), { organizationId: ORG, userId: null }, () =>
      logger.record(infoEvent),
    );
    await withTenant(fakeClient(create, statements), { organizationId: ORG, userId: null }, () =>
      logger.record(infoEvent),
    );

    const savepoints = statements.filter((statement) => statement.startsWith('SAVEPOINT '));

    expect(savepoints).toHaveLength(2);
    expect(new Set(savepoints).size).toBe(2);
    expect(savepoints.every((statement) => /^SAVEPOINT audit_entry_[0-9]+$/.test(statement))).toBe(
      true,
    );
  });
});

/**
 * When the fence itself fails: the insert was refused and then the `ROLLBACK TO SAVEPOINT` was too.
 *
 * The first draft let the second exception replace the first, so the line an operator read named
 * a rollback that could not run and said nothing about why the row was refused. Both are kept: the
 * insert failure as `cause`, the rollback failure in the message — and the error is its own class,
 * because the decorator must not soften it for any severity: after a failed rollback the
 * transaction is not known to be usable, and «the action went on without its row» would be a
 * claim about a commit that may well be refused.
 */
describe('a rollback that fails after a failed insert', () => {
  it('rejects with both failures, the insert one as the cause', async () => {
    const insertFailure = new Error('unsupported Unicode escape sequence');
    const rollbackFailure = new Error('connection reset');
    const create = vi.fn().mockRejectedValue(insertFailure);
    const statements: string[] = [];
    const logger = loggerFor(() => Promise.resolve());

    const outcome = withTenant(
      fakeClient(create, statements, (statement) =>
        statement.startsWith('ROLLBACK TO SAVEPOINT') ? rollbackFailure : undefined,
      ),
      { organizationId: ORG, userId: null },
      () =>
        logger.record(
          event({ action: 'session.signed_in', target: { type: 'SESSION', id: undefined } }),
        ),
    );

    const error = await outcome.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AuditFenceRollbackError);
    expect((error as Error).cause).toBe(insertFailure);
    expect((error as Error).message).toContain('connection reset');
    expect((error as Error).message).toContain('session.signed_in');
  });
});

/**
 * Which events may leave the table at all — and which are refused instead of quietly logged — lives
 * in `audit-unscoped-guard.test.ts`, beside the list that decides it. It is one behaviour, so it has
 * one home; splitting it across two files is how the second copy drifts.
 */
