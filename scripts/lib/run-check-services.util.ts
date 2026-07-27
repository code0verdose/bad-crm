import type { EnvResolution } from './check-env.util.js';
import { exitCodeFor, renderReport } from './check-report.util.js';
import { INVALID_ENV_LINES, MISSING_ENV_FILE_LINES } from './env-problem-report.util.js';
import { runChecks } from './run-checks.util.js';
import type { ServiceCheck } from './service-check.types.js';
import type { ServerEnv } from '../../packages/server/src/infrastructure/bootstrap/env.schema.js';

/**
 * The body of `pnpm check:services`, with every side effect injected so the verdict, the exit code
 * and the shape of the report can be tested without a running stack.
 */

export interface CheckServicesDeps {
  readonly resolveEnv: () => EnvResolution;
  readonly createChecks: (env: ServerEnv, profile: string) => readonly ServiceCheck[];
  readonly write: (line: string) => void;
  readonly now: () => number;
}

export const runCheckServices = async (deps: CheckServicesDeps): Promise<0 | 1> => {
  const resolution = deps.resolveEnv();

  deps.write('');
  deps.write('bad-crm — development services');
  deps.write('');

  if (!resolution.envFileExists) {
    for (const line of MISSING_ENV_FILE_LINES(resolution.envFilePath)) deps.write(line);
    deps.write('');

    return 1;
  }

  if (resolution.env === undefined) {
    for (const line of INVALID_ENV_LINES(resolution)) deps.write(line);
    deps.write('');

    return 1;
  }

  const results = await runChecks(deps.createChecks(resolution.env, resolution.profile), deps.now);

  for (const line of renderReport(results).split('\n')) deps.write(line);

  const exitCode = exitCodeFor(results);

  if (exitCode === 1) {
    deps.write('  One or more required services are not usable.');
    deps.write('  Start the stack with `pnpm docker:up`; diagnosis per service is in');
    deps.write('  docs/runbooks/local-environment.md.');
    deps.write('');
  }

  return exitCode;
};
