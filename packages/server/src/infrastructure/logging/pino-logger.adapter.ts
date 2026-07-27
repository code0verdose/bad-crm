import {
  destination as pinoDestination,
  pino,
  stdTimeFunctions,
  type DestinationStream,
  type Logger,
} from 'pino';

import { type LogFields, type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { APP_INFO } from '@/app-info.constant.js';
import { serializeLogError } from '@/infrastructure/logging/log-error.serializer.js';
import {
  REDACTED_PATHS,
  REDACTED_PLACEHOLDER,
} from '@/infrastructure/logging/log-redaction.constant.js';

export interface RootLoggerOptions {
  readonly level: string;
  /** Version of the running build, stamped on every line so logs identify what produced them. */
  readonly version: string;
  /**
   * Source of the ambient request context. Optional because the logger is created before the first
   * request exists — and because a startup line legitimately has no request to belong to.
   */
  readonly requestContext?: RequestContextPort;
}

/**
 * The one pino instance of the process.
 *
 * Three decisions worth stating:
 *
 * - **stdout only.** No file transport and no rotation: collection is the job of Docker, systemd or
 *   Loki (rules/observability.mdc, rule 1). A second transport is a second thing to run out of disk.
 * - **The context is mixed in, not passed down.** `mixin` reads `AsyncLocalStorage` on every line,
 *   so `requestId`/`organizationId`/`userId` appear without any layer threading them through — the
 *   reason `LoggerPort` takes only fields and a message.
 * - **Redaction is configured here, once.** A logger built anywhere else would not have it, which
 *   is why nothing else in the codebase calls `pino()`.
 *
 * `destination` is a parameter so tests can read the real serialized output instead of trusting a
 * stubbed logger: the assertions about redaction are about bytes, not about calls.
 */
export const createRootLogger = (
  options: RootLoggerOptions,
  // `pino.destination` rather than `process.stdout`: a SonicBoom stream writes with markedly less
  // overhead, and stdout is the only transport this process has (rules/observability.mdc, rule 1).
  destination: DestinationStream = pinoDestination({ dest: 1, sync: false }),
): Logger =>
  pino(
    {
      level: options.level,
      base: { service: APP_INFO.name, role: APP_INFO.role, version: options.version },
      redact: { paths: [...REDACTED_PATHS], censor: REDACTED_PLACEHOLDER },
      serializers: { err: serializeLogError, error: serializeLogError },
      mixin: () => ({ ...options.requestContext?.current() }),
      timestamp: stdTimeFunctions.isoTime,
    },
    destination,
  );

/**
 * `LoggerPort` over pino.
 *
 * The adapter exists so that `application` and `domain` never import a logging library: a use-case
 * that does cannot be unit-tested without a transport, and swapping pino would then mean editing
 * every layer instead of this file.
 */
export class PinoLoggerAdapter implements LoggerPort {
  constructor(private readonly logger: Logger) {}

  debug(fields: LogFields, message: string): void {
    this.logger.debug(fields, message);
  }

  info(fields: LogFields, message: string): void {
    this.logger.info(fields, message);
  }

  warn(fields: LogFields, message: string): void {
    this.logger.warn(fields, message);
  }

  error(fields: LogFields, message: string): void {
    this.logger.error(fields, message);
  }

  child(bindings: LogFields): LoggerPort {
    return new PinoLoggerAdapter(this.logger.child(bindings));
  }
}
