import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from '../repo/repo-fixture.util.js';

export const ENV_EXAMPLE_PATH = '.env.example';

export interface EnvExampleEntry {
  readonly key: string;
  readonly value: string;
  /** `true` when the line is commented out — the variable is documented but not set by default. */
  readonly commented: boolean;
}

const ASSIGNMENT = /^(?<comment>#\s*)?(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/;

/**
 * Parses `.env.example` into entries.
 *
 * Commented-out assignments count as declared: a variable that is documented with a `#` in front
 * (because its default is "unset") is still part of the contract, and leaving it out of the
 * comparison would let a real variable disappear from the template unnoticed.
 */
export const readEnvExample = (): EnvExampleEntry[] =>
  readFileSync(join(repoRoot, ENV_EXAMPLE_PATH), 'utf8')
    .split('\n')
    .map((line) => ASSIGNMENT.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      key: match.groups?.key ?? '',
      value: (match.groups?.value ?? '').trim(),
      commented: match.groups?.comment !== undefined,
    }));

/** Interpolations of a compose file: `${VAR}` and `${VAR:-default}`. */
const COMPOSE_INTERPOLATION = /\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}/g;

/**
 * Variables the compose file actually interpolates.
 *
 * Comment lines are stripped first: the header of `docker-compose.yml` explains the convention
 * using a literal `${VAR:-dev_default}`, and a prose example is not a variable anyone has to
 * declare in the template.
 */
export const composeInterpolatedVariables = (): string[] => {
  const body = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  return [...new Set([...body.matchAll(COMPOSE_INTERPOLATION)].map(([, name]) => name ?? ''))];
};

/**
 * Variables consumed by the tooling itself rather than by a service definition or by the
 * application, so neither of the two automatic extractions above can find them.
 */
export const TOOLING_ENV_KEYS = [
  // Read by the `docker compose` CLI and by scripts/docker/up.sh to pick the profile.
  'COMPOSE_PROFILES',
] as const;
