import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { ConflictError, ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import { translateTransientDatabaseFailure } from '@/infrastructure/persistence/prisma/transient-database-failure.util.js';

/**
 * Which database failures mean «a retry would have succeeded», and the one answer they all get.
 *
 * The shapes below are not guessed: every one of them was produced by Prisma 6.19.3 against
 * PostgreSQL 16 in `test/integration/db/transient-database-failure.test.ts`, which is the file that
 * turns red when an upgrade changes them. The part worth knowing before reading the table — a
 * deadlock or a lock timeout hit by a **model** call (`tx.team.update`) does not arrive as a known
 * request error with a code at all. It arrives as `PrismaClientUnknownRequestError`, and the
 * SQLSTATE exists only inside the message, as the `Debug` rendering of the engine's error.
 */

const known = (code: string, meta?: Record<string, unknown>, message = `failed with ${code}`) =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: 'test',
    ...(meta === undefined ? {} : { meta }),
  });

/** The measured shape of a model call failing on the server side: SQLSTATE only in the message. */
const unknownWithSqlState = (sqlState: string): Prisma.PrismaClientUnknownRequestError =>
  new Prisma.PrismaClientUnknownRequestError(
    [
      '',
      'Invalid `tx.team.update()` invocation in',
      '/srv/app/dist/infrastructure/persistence/prisma/team.repository.js:40:21',
      '',
      'Error occurred during query execution:',
      `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlState}", message: "whatever", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    ].join('\n'),
    { clientVersion: 'test' },
  );

const EXPIRED_ON_QUERY =
  'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5012 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.';
const EXPIRED_ON_COMMIT =
  'Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5003 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.';
const START_TIMEOUT = 'Unable to start a transaction in the given time.';

describe('translateTransientDatabaseFailure — translated', () => {
  it.each([
    [
      'P2034 (model call under SERIALIZABLE)',
      known('P2034', { modelName: 'Team' }),
      'write_conflict',
    ],
    [
      'P2010 / 40P01 (raw statement)',
      known('P2010', { code: '40P01', message: 'ERROR: deadlock detected' }),
      'deadlock_detected',
    ],
    [
      'P2010 / 40001 (raw statement)',
      known('P2010', { code: '40001', message: 'ERROR: could not serialize access' }),
      'serialization_failure',
    ],
    [
      'P2010 / 55P03 (raw statement, lock_timeout)',
      known('P2010', { code: '55P03', message: 'ERROR: canceling statement due to lock timeout' }),
      'lock_not_available',
    ],
    [
      'P2010 / 55P03 (raw statement, NOWAIT)',
      known('P2010', { code: '55P03', message: 'ERROR: could not obtain lock on row' }),
      'lock_not_available',
    ],
    ['unknown / 40P01 (model call)', unknownWithSqlState('40P01'), 'deadlock_detected'],
    ['unknown / 40001 (model call)', unknownWithSqlState('40001'), 'serialization_failure'],
    ['unknown / 55P03 (model call)', unknownWithSqlState('55P03'), 'lock_not_available'],
    [
      'P2028 expired on a query',
      known('P2028', { error: EXPIRED_ON_QUERY }),
      'transaction_expired',
    ],
    [
      'P2028 expired on the commit',
      known('P2028', { error: EXPIRED_ON_COMMIT }),
      'transaction_expired',
    ],
    [
      'P2028 no connection within maxWait',
      known('P2028', { error: START_TIMEOUT }, `Transaction API error: ${START_TIMEOUT}`),
      'transaction_start_timeout',
    ],
  ])('%s → 503 service_unavailable', (_label, error, reason) => {
    const translated = translateTransientDatabaseFailure(error);

    expect(translated).toBeInstanceOf(ServiceUnavailableError);

    const refusal = translated as ServiceUnavailableError;

    expect(refusal.status).toBe(503);
    expect(refusal.code).toBe('service_unavailable');
    expect(refusal.retryAfterSeconds).toBe(1);
    expect(refusal.details).toEqual(expect.objectContaining({ dependency: 'postgres', reason }));
    // The driver error stays reachable as the cause, and only there: `details` is what the log gets.
    expect(refusal.cause).toBe(error);
  });

  it('puts no driver text into details — the message quotes file paths and query fragments', () => {
    const refusal = translateTransientDatabaseFailure(
      unknownWithSqlState('40P01'),
    ) as ServiceUnavailableError;

    expect(Object.keys(refusal.details ?? {}).sort()).toEqual(['dependency', 'reason', 'sqlState']);
    expect(refusal.details).toEqual({
      dependency: 'postgres',
      reason: 'deadlock_detected',
      sqlState: '40P01',
    });
  });
});

describe('translateTransientDatabaseFailure — left alone, so they stay a loud 500', () => {
  it.each([
    // No statement_timeout is configured anywhere in the product, so 57014 means somebody cancelled
    // the statement or a query ran past a limit set on purpose: re-running it is re-running the same
    // slow statement, and the page belongs at `error`.
    [
      'P2010 / 57014 statement timeout',
      known('P2010', {
        code: '57014',
        message: 'ERROR: canceling statement due to statement timeout',
      }),
    ],
    ['unknown / 57014 statement timeout', unknownWithSqlState('57014')],
    // A transaction used after it ended is a defect in this code, not contention.
    [
      'P2028 used after commit',
      known('P2028', {
        error: 'Transaction already closed: A query cannot be executed on a committed transaction.',
      }),
    ],
    [
      'P2028 transaction not found',
      known('P2028', {
        error:
          "Transaction not found. Transaction ID is invalid, refers to an old closed transaction Prisma doesn't have information about anymore, or was obtained before disconnecting.",
      }),
    ],
    ['P2028 with no meta at all', known('P2028')],
    ['P2010 / 23505 (the repository answers that one)', known('P2010', { code: '23505' })],
    ['P2010 / 23503 foreign key', known('P2010', { code: '23503' })],
    ['P2010 with a malformed meta', known('P2010', { code: 40001 })],
    ['P2002 unique constraint', known('P2002', { target: ['slug'] })],
    ['P2025 record not found', known('P2025')],
    [
      'unknown with no SQLSTATE in it',
      new Prisma.PrismaClientUnknownRequestError('Error in connector: boom', {
        clientVersion: 'test',
      }),
    ],
    ['a row-level-security refusal', unknownWithSqlState('42501')],
    ['a plain Error that merely quotes the shape', new Error('PostgresError { code: "40P01" }')],
    ['a string', 'PostgresError { code: "40P01" }'],
  ])('%s', (_label, error) => {
    expect(translateTransientDatabaseFailure(error)).toBe(error);
  });

  it('passes an AppError through untouched', () => {
    const conflict = new ConflictError('team_already_exists');

    expect(translateTransientDatabaseFailure(conflict)).toBe(conflict);
  });
});
