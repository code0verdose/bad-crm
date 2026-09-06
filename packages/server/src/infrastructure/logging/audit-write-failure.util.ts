/** What the `audit.write_degraded` line says about the failure: enough to triage, never the row. */
export interface AuditWriteFailure {
  readonly type: string;
  readonly message: string;
  /** The library's own code (`P2010` for a driver error), when the failure carries one. */
  readonly code?: string;
  /** The database's SQLSTATE (`22P05`, `23505`), when the failure carries one under `meta`. */
  readonly driverCode?: string;
}

/** Long enough for any SQLSTATE sentence, short enough that a dumped object never fits. */
const MESSAGE_LIMIT = 200;

/**
 * The failure behind a degraded write, reduced to three fields **by construction**.
 *
 * The line that reports a missing row is read by everyone who can read the logs, and the first
 * draft passed the error object through whole. That relied on the error being terse, and the one
 * Prisma throws for an invalid argument is not: `PrismaClientValidationError` prints the arguments
 * of the call in its message, `after` included — the payload the adapter redacts and the decorator
 * deliberately leaves off the line, back on the line through the error. Restricting the shape here
 * is what makes «no payload on the line» a property of the code rather than of which error the
 * database happened to throw.
 *
 * The message is cut to its first non-empty line and to `MESSAGE_LIMIT` characters: the error's own
 * sentence is on the first line, and an argument dump is never one line. The stack is not carried
 * at all — the line has the action, the request and the codes, and the stack of a driver error
 * points into the driver.
 */
export const describeAuditWriteFailure = (failure: unknown): AuditWriteFailure => {
  if (!(failure instanceof Error)) {
    return { type: 'non-error', message: firstLine(String(failure)) };
  }

  const code = stringField(failure, 'code');
  const meta = (failure as { meta?: unknown }).meta;
  const driverCode =
    typeof meta === 'object' && meta !== null ? stringField(meta, 'code') : undefined;

  return {
    type: failure.name,
    message: firstLine(failure.message),
    ...(code === undefined ? {} : { code }),
    ...(driverCode === undefined ? {} : { driverCode }),
  };
};

const firstLine = (text: string): string =>
  (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, MESSAGE_LIMIT);

const stringField = (holder: object, field: string): string | undefined => {
  const value = (holder as Record<string, unknown>)[field];

  return typeof value === 'string' ? value : undefined;
};
