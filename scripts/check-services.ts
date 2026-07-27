/**
 * `pnpm check:services` — does the development stack actually work?
 *
 * `docker compose ps` answers whether five containers are running. This answers the question a
 * contributor really has: can the application connect, with the credentials in `.env`, and find
 * what it expects on the other side. The two answers differ exactly when it matters — a Postgres
 * that is `healthy` but was initialised before `btree_gist` was added to the bootstrap, an
 * `app_user` that somebody granted BYPASSRLS, a bucket the initialiser never created, a MinIO key
 * that does not match `.env`.
 *
 * Exit code: 1 if a *required* service (Postgres, Redis, MinIO) is unusable. Optional services
 * (Meilisearch, SMTP) are reported and, when the profile or the configuration leaves them out,
 * marked SKIPPED — the application is required to run without them.
 *
 * Nothing here prints a secret: targets are masked URLs and every reported line goes through
 * `redactSecrets`.
 */
import { createMeilisearchCheck } from './lib/checks/meilisearch.check.js';
import { createPostgresCheck } from './lib/checks/postgres.check.js';
import { createRedisCheck } from './lib/checks/redis.check.js';
import { createS3Check } from './lib/checks/s3.check.js';
import { createSmtpCheck } from './lib/checks/smtp.check.js';
import { skipReasonFor, skippedCheck } from './lib/check-plan.util.js';
import { hostPortOf, postgresTargetOf, redisTargetOf } from './lib/connection-target.util.js';
import { getText, headStatus } from './lib/io/http.io.js';
import { withPostgresConnection } from './lib/io/postgres.io.js';
import { readBanner, sendLines } from './lib/io/tcp.io.js';
import { isEntryPoint, resolveEnvFromDisk } from './lib/repo-paths.util.js';
import { runCheckServices } from './lib/run-check-services.util.js';
import type { ServiceCheck } from './lib/service-check.types.js';
import type { ServerEnv } from '../packages/server/src/infrastructure/bootstrap/env.schema.js';

/** Generous enough for a cold container, short enough that a wedged service is not a coffee break. */
const TIMEOUT_MS = 8000;

const createChecks = (env: ServerEnv, profile: string): ServiceCheck[] => {
  const context = { meiliHost: env.MEILI_HOST, smtpUrl: env.SMTP_URL, profile };

  const meiliSkip = skipReasonFor('meilisearch', context);
  const smtpSkip = skipReasonFor('smtp', context);

  return [
    createPostgresCheck({
      databaseUrl: env.DATABASE_URL,
      target: postgresTargetOf(env.DATABASE_URL),
      withConnection: (run) => withPostgresConnection(env.DATABASE_URL, TIMEOUT_MS, run),
    }),
    createRedisCheck({
      redisUrl: env.REDIS_URL,
      target: redisTargetOf(env.REDIS_URL),
      send: (target, commands) => sendLines(target, commands, TIMEOUT_MS),
    }),
    createS3Check({
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
      now: () => new Date(),
      head: (request) => headStatus(request, TIMEOUT_MS),
    }),
    env.MEILI_HOST !== undefined && meiliSkip === undefined
      ? createMeilisearchCheck({
          host: env.MEILI_HOST,
          get: (url) => getText(url, TIMEOUT_MS),
        })
      : skippedCheck('meilisearch', env.MEILI_HOST ?? '-', meiliSkip ?? ''),
    env.SMTP_URL !== undefined && smtpSkip === undefined
      ? createSmtpCheck({
          target: hostPortOf(env.SMTP_URL),
          readBanner: (target) => readBanner(target, TIMEOUT_MS),
        })
      : skippedCheck('smtp', env.SMTP_URL ?? '-', smtpSkip ?? ''),
  ];
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runCheckServices({
    resolveEnv: resolveEnvFromDisk,
    createChecks,
    // eslint-disable-next-line no-console -- this script *is* the terminal report
    write: (line) => console.log(line),
    now: () => Date.now(),
  });
}
