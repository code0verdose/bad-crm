import {
  toEnvIssues,
  type EnvIssue,
} from '../../packages/server/src/infrastructure/bootstrap/env.errors.js';
import {
  serverEnvSchema,
  type ServerEnv,
} from '../../packages/server/src/infrastructure/bootstrap/env.schema.js';

import { parseEnvFile } from './env-file.util.js';

/**
 * Configuration as these scripts see it.
 *
 * The values come from the **same** Zod schema the server parses at boot — not from a second reader
 * that would drift away from it. A smoke check built on its own idea of `DATABASE_URL` proves that
 * its own idea works.
 */
export interface EnvResolution {
  readonly envFilePath: string;
  readonly envFileExists: boolean;
  /** Present only when the configuration parsed cleanly. */
  readonly env?: ServerEnv;
  /** Every invalid variable, by name and reason. Never carries a value: half of them are secrets. */
  readonly issues: readonly EnvIssue[];
  /**
   * Active compose profile, read from `COMPOSE_PROFILES` with the same precedence `docker compose`
   * uses — shell first, then `.env`. It decides which services are supposed to be running at all,
   * and therefore which optional checks are "skipped" rather than "failed". Not part of the server
   * schema: the application never reads it, only the tooling around it does.
   */
  readonly profile: string;
}

export const DEFAULT_COMPOSE_PROFILE = 'default';

export interface ResolveToolingEnvOptions {
  readonly repoRoot: string;
  readonly processEnv: Record<string, string | undefined>;
  /** Returns the file contents, or `undefined` when the file does not exist. */
  readonly readFile: (path: string) => string | undefined;
}

export const resolveToolingEnv = (options: ResolveToolingEnvOptions): EnvResolution => {
  const envFilePath = `${options.repoRoot}/.env`;
  const contents = options.readFile(envFilePath);

  if (contents === undefined) {
    return {
      envFilePath,
      envFileExists: false,
      issues: [],
      profile: options.processEnv['COMPOSE_PROFILES'] ?? DEFAULT_COMPOSE_PROFILE,
    };
  }

  // Shell wins over the file, the same precedence `docker compose` and dotenv use: an operator
  // overriding a variable for one command must not be silently ignored by the check.
  const source = { ...parseEnvFile(contents), ...stripUndefined(options.processEnv) };
  const profile = source['COMPOSE_PROFILES'] ?? DEFAULT_COMPOSE_PROFILE;
  const parsed = serverEnvSchema.safeParse(source);

  return parsed.success
    ? { envFilePath, envFileExists: true, env: parsed.data, issues: [], profile }
    : { envFilePath, envFileExists: true, issues: toEnvIssues(parsed.error), profile };
};

const stripUndefined = (source: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
