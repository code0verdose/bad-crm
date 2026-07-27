import type { EnvResolution } from './check-env.util.js';
import { summarize } from './check-report.util.js';
import { INVALID_ENV_LINES, MISSING_ENV_FILE_LINES } from './env-problem-report.util.js';
import { runChecks } from './run-checks.util.js';
import type { CheckResult, ServiceCheck } from './service-check.types.js';
import type { ServerEnv } from '../../packages/server/src/infrastructure/bootstrap/env.schema.js';

/**
 * The body of the preflight that `pnpm dev` runs before turbo.
 *
 * It exists because of one acceptance criterion of STORY-001-06: `pnpm dev` without a running
 * docker stack must say «run `pnpm docker:up` first» instead of dying inside a driver with
 * `ECONNREFUSED`. It is called explicitly from the `dev` script rather than from a `predev` hook —
 * `.npmrc` sets `enable-pre-post-scripts=false`, so a `predev` script would never run.
 *
 * Quiet on success (three lines), loud and specific on failure, and never blocking on an optional
 * service: the application is required to start without Meilisearch and SMTP.
 */

export interface PreflightDeps {
  readonly resolveEnv: () => EnvResolution;
  readonly createChecks: (env: ServerEnv, profile: string) => readonly ServiceCheck[];
  readonly write: (line: string) => void;
  readonly now: () => number;
}

const describe = (result: CheckResult): string =>
  `  ${result.service} (${result.target}): ${result.details.join('; ')}`;

export const runPreflight = async (deps: PreflightDeps): Promise<0 | 1> => {
  const resolution = deps.resolveEnv();

  if (!resolution.envFileExists) {
    deps.write('');
    deps.write('pnpm dev — preflight failed: no configuration');
    deps.write('');
    for (const line of MISSING_ENV_FILE_LINES(resolution.envFilePath)) deps.write(line);
    deps.write('');

    return 1;
  }

  if (resolution.env === undefined) {
    deps.write('');
    deps.write('pnpm dev — preflight failed: invalid configuration');
    deps.write('');
    for (const line of INVALID_ENV_LINES(resolution)) deps.write(line);
    deps.write('');

    return 1;
  }

  const results = await runChecks(deps.createChecks(resolution.env, resolution.profile), deps.now);
  const summary = summarize(results);

  for (const result of results.filter(
    (entry) => entry.status === 'failed' && entry.requirement === 'optional',
  )) {
    deps.write(
      `warning: optional service ${result.service} is not answering — ${result.details.join('; ')}`,
    );
  }

  if (summary.requiredFailures === 0) {
    const reachable = results.filter((result) => result.status === 'ok').map((r) => r.service);

    deps.write(`preflight: ${reachable.join(', ')} ready — starting the dev processes`);

    return 0;
  }

  deps.write('');
  deps.write('pnpm dev — preflight failed: required services are not reachable');
  deps.write('');
  for (const result of results.filter(
    (entry) => entry.status === 'failed' && entry.requirement === 'required',
  )) {
    deps.write(describe(result));
  }
  deps.write('');
  deps.write('  Start them first:  pnpm docker:up');
  deps.write('  Deeper diagnosis:  pnpm check:services, docs/runbooks/local-environment.md');
  deps.write('');

  return 1;
};
