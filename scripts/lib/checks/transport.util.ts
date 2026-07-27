import type { CheckOutcome } from '../service-check.types.js';
import { describeSocketError } from '../socket-error.util.js';

/**
 * A check whose transport never connected.
 *
 * Without this, a refused socket falls through to the generic handler in `run-checks.util.ts`,
 * which can only say "see the runbook" — while the caller knows perfectly well that the right
 * answer for a dev stack is `pnpm docker:up`. A verdict without a next step is the thing this
 * script exists to replace.
 */
export const withTransportFailure = async (
  remedy: string,
  run: () => Promise<CheckOutcome>,
): Promise<CheckOutcome> => {
  try {
    return await run();
  } catch (error) {
    return { status: 'failed', details: [describeSocketError(error)], remedy };
  }
};

export const DEV_STACK_REMEDY =
  'start the development services with `pnpm docker:up`; if they are running, the port in .env may point elsewhere — see docs/runbooks/local-environment.md §5.1';
