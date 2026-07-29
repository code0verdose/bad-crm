import { type LogFields, type LoggerPort } from '@/application/platform/ports/logger.port.js';

export interface RecordedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly message: string;
}

/**
 * A `LoggerPort` that keeps what was written, so a test can assert on the *content* of a log line.
 *
 * Needed here rather than a spy: what these suites check is that an email never reaches a log and
 * that a masked subject does — a claim about the fields, not about the call happening
 * (rules/observability.mdc, rule 5).
 */
export const recordingLogger = (): { logger: LoggerPort; lines: RecordedLog[] } => {
  const lines: RecordedLog[] = [];
  const record =
    (level: RecordedLog['level']) =>
    (fields: LogFields, message: string): void => {
      lines.push({ level, fields, message });
    };

  const logger: LoggerPort = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };

  return { logger, lines };
};

/** Every value written into any recorded line, flattened — the haystack for "no secret leaked". */
export const recordedValues = (lines: readonly RecordedLog[]): string =>
  lines.map((line) => `${line.message} ${JSON.stringify(line.fields)}`).join('\n');
