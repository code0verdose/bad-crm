/**
 * Preflight for `pnpm dev`.
 *
 * STORY-001-06 requires that `pnpm dev` without a running docker stack ends with «start it with
 * `pnpm docker:up`» rather than with a raw `ECONNREFUSED` from inside a driver. This is that check.
 *
 * It is invoked explicitly from the `dev` script — `"dev": "tsx scripts/preflight.ts && turbo run
 * dev"` — and **not** through a `predev` hook: `.npmrc` sets `enable-pre-post-scripts=false`, so a
 * `predev` script would silently never run and the guarantee would exist only on paper.
 *
 * Budget: well under two seconds. It opens a TCP connection to each required service and nothing
 * more; the deep verification (extensions, roles, bucket, credentials) is `pnpm check:services`.
 */
import { skipReasonFor, skippedCheck } from './lib/check-plan.util.js';
import { createReachabilityCheck } from './lib/checks/reachability.check.js';
import { hostPortOf, postgresTargetOf, redisTargetOf } from './lib/connection-target.util.js';
import { connectTcp } from './lib/io/tcp.io.js';
import { isEntryPoint, resolveEnvFromDisk } from './lib/repo-paths.util.js';
import { runPreflight } from './lib/run-preflight.util.js';
import type { ServiceCheck } from './lib/service-check.types.js';
import type { ServerEnv } from '../packages/server/src/infrastructure/bootstrap/env.schema.js';

const TIMEOUT_MS = 1500;
const DOCKER_UP = 'start the development services with `pnpm docker:up`';

const createChecks = (env: ServerEnv, profile: string): ServiceCheck[] => {
  const context = { meiliHost: env.MEILI_HOST, smtpUrl: env.SMTP_URL, profile };
  const meiliSkip = skipReasonFor('meilisearch', context);
  const smtpSkip = skipReasonFor('smtp', context);

  const reachable = (
    service: string,
    target: { host: string; port: number },
    requirement: 'required' | 'optional',
  ): ServiceCheck =>
    createReachabilityCheck({
      service,
      requirement,
      target,
      remedy: DOCKER_UP,
      timeoutMs: TIMEOUT_MS,
      connect: connectTcp,
    });

  return [
    reachable('postgres', postgresTargetOf(env.DATABASE_URL), 'required'),
    reachable('redis', redisTargetOf(env.REDIS_URL), 'required'),
    reachable('minio', hostPortOf(env.S3_ENDPOINT), 'required'),
    env.MEILI_HOST !== undefined && meiliSkip === undefined
      ? reachable('meilisearch', hostPortOf(env.MEILI_HOST), 'optional')
      : skippedCheck('meilisearch', env.MEILI_HOST ?? '-', meiliSkip ?? ''),
    env.SMTP_URL !== undefined && smtpSkip === undefined
      ? reachable('smtp', hostPortOf(env.SMTP_URL), 'optional')
      : skippedCheck('smtp', env.SMTP_URL ?? '-', smtpSkip ?? ''),
  ];
};

/**
 * Escape hatch. `pnpm dev` now refuses to start without a configuration file and the required
 * services, which is right for anyone touching the server — and wrong for someone editing only
 * `packages/client` or `packages/shared`, where no backing service is involved. Without a way out
 * the guard would push that person to bypass the `dev` script entirely, which is worse: they would
 * also lose the watchers. Deliberately an environment variable and not a flag, so it can be set
 * once per shell.
 */
const PREFLIGHT_SKIPPED = process.env['SKIP_PREFLIGHT'] === '1';

if (isEntryPoint(import.meta.url) && PREFLIGHT_SKIPPED) {
  // eslint-disable-next-line no-console -- this script *is* the terminal report
  console.log('preflight skipped (SKIP_PREFLIGHT=1) — services are not checked');
} else if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runPreflight({
    resolveEnv: resolveEnvFromDisk,
    createChecks,
    // eslint-disable-next-line no-console -- this script *is* the terminal report
    write: (line) => console.log(line),
    now: () => Date.now(),
  });
}
