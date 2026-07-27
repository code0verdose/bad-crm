import { redactSecrets } from './connection-target.util.js';
import type { CheckOutcome, CheckResult, ServiceCheck } from './service-check.types.js';

/**
 * Runs every check concurrently and never lets one of them take the report down with it.
 *
 * A check that throws — DNS failure, a driver that rejects with something other than an `Error`,
 * a bug here — becomes a failed result for that one service. Letting the rejection escape would
 * replace a five-line report with a stack trace and hide the four services that are fine.
 */

const sanitize = (outcome: CheckOutcome): CheckOutcome => ({
  status: outcome.status,
  details: outcome.details.map(redactSecrets),
  ...(outcome.remedy === undefined ? {} : { remedy: redactSecrets(outcome.remedy) }),
});

export const runChecks = async (
  checks: readonly ServiceCheck[],
  now: () => number,
): Promise<CheckResult[]> =>
  Promise.all(
    checks.map(async (check): Promise<CheckResult> => {
      const startedAt = now();

      const outcome = await check.run().catch((error: unknown): CheckOutcome => ({
        status: 'failed',
        details: [error instanceof Error ? error.message : String(error)],
        remedy: 'see docs/runbooks/local-environment.md for the diagnosis of this service',
      }));

      return {
        service: check.service,
        requirement: check.requirement,
        target: redactSecrets(check.target),
        durationMs: Math.max(now() - startedAt, 1),
        ...sanitize(outcome),
      };
    }),
  );
