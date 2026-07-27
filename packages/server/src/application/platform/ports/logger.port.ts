/**
 * Structured fields of one log line. Values are identifiers, sizes and enums — never a secret and
 * never user content (CLAUDE.md, «Что нельзя логировать никогда»).
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * How `application` writes a log line.
 *
 * The port exists so that use-cases do not import pino: the logging library is an infrastructure
 * choice, and a use-case that imports it can no longer be unit-tested without a transport
 * (rules/observability.mdc, rule 2 — the request context is mixed in by the adapter, so nothing is
 * threaded through the call chain by hand).
 */
export interface LoggerPort {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  /** A logger with permanent extra fields, for a subsystem or a job. */
  child(bindings: LogFields): LoggerPort;
}
