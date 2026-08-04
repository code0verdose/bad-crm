import { RateLimitedError } from '@/domain/shared/errors/app.errors.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';

export interface ClientErrorReport {
  readonly message: string;
  readonly stack: string | undefined;
  readonly appVersion: string;
  readonly route: string;
  readonly reference: string;
  readonly requestId: string | undefined;
}

export interface ClientErrorReporter {
  readonly userId: string | undefined;
  readonly ipAddress: string | undefined;
}

/**
 * Writes a browser failure into the same log as everything else.
 *
 * **`source: 'client'` is the whole point of the field.** Without it a stack from a bundle sits
 * beside a stack from the server and reads as a server failure — the operator chases a backend bug
 * that never happened. With it, one filter separates the two populations.
 *
 * **The level is `warn`, not `error`.** An error in the server log means this process failed; this
 * process did exactly what it was asked. A report that raised the error rate would make the metric
 * that says «the API is unhealthy» respond to a broken button in somebody's browser.
 *
 * The report is logged as **fields**, never interpolated into the message: the message is a constant
 * so that a log search groups them, and the stack is a value that must not become part of a format
 * string.
 */
export class RecordClientErrorUseCase {
  constructor(
    private readonly rateLimit: RateLimitPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(report: ClientErrorReport, reporter: ClientErrorReporter): Promise<void> {
    const decision = await this.rateLimit.consume('client_error_report', {
      userId: reporter.userId,
      ipAddress: reporter.ipAddress,
    });

    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    this.logger.warn(
      {
        source: 'client',
        reference: report.reference,
        appVersion: report.appVersion,
        route: report.route,
        clientMessage: report.message,
        ...(report.stack === undefined ? {} : { clientStack: report.stack }),
        ...(report.requestId === undefined ? {} : { clientRequestId: report.requestId }),
      },
      'client error reported',
    );
  }
}
