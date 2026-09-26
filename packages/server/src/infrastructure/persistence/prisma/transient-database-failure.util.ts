import { Prisma } from '@prisma/client';

import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';

/**
 * Why a database failure was judged transient — the `details.reason` of the 503, read from the
 * `warn` line by whoever counts them. Not sent to the client: `details` never reaches a 5xx body.
 */
type TransientDatabaseReason =
  | 'write_conflict'
  | 'deadlock_detected'
  | 'serialization_failure'
  | 'lock_not_available'
  | 'transaction_expired'
  | 'transaction_start_timeout';

/**
 * The SQLSTATEs that mean «another transaction was in the way», and nothing else.
 *
 * **`57014` (`query_canceled`) is left out on purpose.** Nothing in the product sets
 * `statement_timeout` (migrations set it `LOCAL` to their own transaction), so a `57014` reaching a
 * request means an operator cancelled the statement or a limit somebody configured deliberately was
 * exceeded — a statement that ran too long, not one that waited on a lock. A retry re-runs the same
 * statement, and under load it multiplies it; that failure has to page, so it stays a `500` at
 * `error`. A bounded *lock wait* has its own SQLSTATE, `55P03`, which is translated below — and a
 * lock wait bounded by nothing at all ends as the expired transaction (`P2028`), also translated.
 */
const TRANSIENT_SQL_STATES: Readonly<Record<string, TransientDatabaseReason>> = {
  '40P01': 'deadlock_detected',
  '40001': 'serialization_failure',
  '55P03': 'lock_not_available',
};

/**
 * One second: a deadlock is resolved the moment PostgreSQL picks its victim, a serialization failure
 * the moment the other transaction commits, and a lock or a pool slot is held for at most the
 * five-second transaction ceiling (`tenant.context.ts`). A number larger than the typical wait would
 * only make the retry slower than it needs to be; the header is advice, not a promise.
 */
const RETRY_AFTER_SECONDS = 1;

/**
 * The `Debug` rendering of the engine's error, which is the only place a model call carries its
 * SQLSTATE: Prisma 6.19.3 reports a deadlock or a lock timeout hit by `tx.team.update()` as
 * `PrismaClientUnknownRequestError` with no `code`, and the message ends in
 * `PostgresError { code: "40P01", … }` (measured in `test/integration/db/transient-database-failure.test.ts`).
 *
 * Reading a message is fragile, and that is accepted here because the failure mode is the safe one:
 * a Prisma upgrade that renders it differently makes this match nothing, the error stays untranslated
 * and is answered `500` at `error` — exactly today's behaviour — while the integration test turns red.
 */
const ENGINE_SQL_STATE = /PostgresError \{ code: "([0-9A-Z]{5})"/;

/**
 * `P2028` covers both «the transaction timed out» and «this code used a transaction after it ended».
 * Only the first is contention; the second is a defect and must stay loud. The engine says which in
 * `meta.error`, and these are its two timing sentences, on the query and on the commit alike.
 */
const EXPIRED_TRANSACTION = /expired transaction/;
const TRANSACTION_START_TIMEOUT = /Unable to start a transaction in the given time/;

/**
 * The PostgreSQL SQLSTATE behind a `P2010`, or `undefined` when the shape is not the one we know.
 *
 * `meta` is typed as `unknown` by the client, so it is narrowed rather than cast: a Prisma upgrade
 * that changes the shape must make this return `undefined` — leaving the error untranslated and
 * loud — instead of throwing inside the error path, where the original failure would be lost.
 */
export const sqlStateOf = (error: Prisma.PrismaClientKnownRequestError): string | undefined =>
  stringField(error.meta, 'code');

const stringField = (meta: unknown, field: string): string | undefined => {
  if (typeof meta !== 'object' || meta === null) return undefined;

  const value: unknown = (meta as Record<string, unknown>)[field];

  return typeof value === 'string' ? value : undefined;
};

interface Classified {
  readonly reason: TransientDatabaseReason;
  readonly sqlState?: string;
}

const classifyKnown = (error: Prisma.PrismaClientKnownRequestError): Classified | undefined => {
  // «Transaction failed due to a write conflict or a deadlock. Please retry your transaction» — what
  // a model call gets for a serialization failure. Prisma already calls it retryable.
  if (error.code === 'P2034') return { reason: 'write_conflict' };

  if (error.code === 'P2010') {
    const sqlState = sqlStateOf(error);
    const reason = sqlState === undefined ? undefined : TRANSIENT_SQL_STATES[sqlState];

    return reason === undefined || sqlState === undefined ? undefined : { reason, sqlState };
  }

  if (error.code === 'P2028') {
    const detail = stringField(error.meta, 'error') ?? '';

    if (EXPIRED_TRANSACTION.test(detail)) return { reason: 'transaction_expired' };
    if (TRANSACTION_START_TIMEOUT.test(detail)) return { reason: 'transaction_start_timeout' };
  }

  return undefined;
};

const classifyUnknown = (error: Prisma.PrismaClientUnknownRequestError): Classified | undefined => {
  const sqlState = ENGINE_SQL_STATE.exec(error.message)?.[1];
  const reason = sqlState === undefined ? undefined : TRANSIENT_SQL_STATES[sqlState];

  return reason === undefined || sqlState === undefined ? undefined : { reason, sqlState };
};

/**
 * A database failure that a retry would have got past, as `503 service_unavailable` with
 * `Retry-After`; anything else, returned exactly as received.
 *
 * Those failures are this system losing a race it is built to lose sometimes — two writers on one
 * row, a pool full for a moment — not a defect. Answered `500 internal_error` they told the client
 * «our bug, do not bother» and filed a stack trace at `error`, the level an operator is paged on.
 * The error handler logs an `AppError` that names a retry delay at `warn` (`error-handler.middleware.ts`),
 * so carrying `retryAfterSeconds` is what moves them there; no second rule is needed for it.
 *
 * `details` holds the classification and the SQLSTATE only. The driver message is deliberately left
 * out: it quotes the source path and the query fragment, and it stays reachable as `cause`.
 */
export const translateTransientDatabaseFailure = (error: unknown): unknown => {
  let classified: Classified | undefined;

  if (error instanceof Prisma.PrismaClientKnownRequestError) classified = classifyKnown(error);
  else if (error instanceof Prisma.PrismaClientUnknownRequestError)
    classified = classifyUnknown(error);

  if (classified === undefined) return error;

  return new ServiceUnavailableError(
    { dependency: 'postgres', ...classified },
    error,
    RETRY_AFTER_SECONDS,
  );
};
