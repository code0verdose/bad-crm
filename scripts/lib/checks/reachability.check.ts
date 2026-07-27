import type { HostPort } from '../connection-target.util.js';
import type { CheckOutcome, CheckRequirement, ServiceCheck } from '../service-check.types.js';

/**
 * "Is anything listening on this port" — the cheap check `scripts/preflight.ts` runs before
 * `pnpm dev`.
 *
 * Deliberately shallower than `pnpm check:services`: preflight has a budget of a couple of seconds
 * and one job, which is to replace a raw `ECONNREFUSED` from inside a driver with a sentence naming
 * the service and the command that starts it. Extensions, roles and buckets are the deep check's
 * business.
 */

export const createReachabilityCheck = (options: {
  readonly service: string;
  readonly requirement: CheckRequirement;
  readonly target: HostPort;
  readonly remedy: string;
  readonly timeoutMs: number;
  readonly connect: (target: HostPort, timeoutMs: number) => Promise<void>;
}): ServiceCheck => ({
  service: options.service,
  requirement: options.requirement,
  target: `${options.target.host}:${options.target.port}`,
  run: async (): Promise<CheckOutcome> => {
    try {
      await options.connect(options.target, options.timeoutMs);

      return { status: 'ok', details: ['port is accepting connections'] };
    } catch (error) {
      return {
        status: 'failed',
        details: [error instanceof Error ? error.message : String(error)],
        remedy: options.remedy,
      };
    }
  },
});
