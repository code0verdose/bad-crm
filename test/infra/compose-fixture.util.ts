import { parse as parseYaml } from 'yaml';

import { readRepoFile } from '../repo/repo-fixture.util.js';

/** Long syntax of a published port; the short syntax is a plain `host_ip:published:target` string. */
export interface ComposePortMapping {
  target?: number;
  published?: string | number;
  host_ip?: string;
  protocol?: string;
  mode?: string;
}

export interface ComposeHealthcheck {
  test?: string | string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
}

export interface ComposeDependsOn {
  condition?: string;
  restart?: boolean;
  required?: boolean;
}

export interface ComposeService {
  image?: string;
  profiles?: string[];
  ports?: (string | ComposePortMapping)[];
  environment?: Record<string, string> | string[];
  volumes?: string[];
  healthcheck?: ComposeHealthcheck;
  depends_on?: Record<string, ComposeDependsOn> | string[];
  labels?: Record<string, string>;
  restart?: string;
  command?: string | string[];
  entrypoint?: string | string[];
}

export interface ComposeFile {
  name?: string;
  version?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
}

export const COMPOSE_PATH = 'docker-compose.yml';

/** Parameterised role bootstrap, executed once per installation before the first migration. */
export const BOOTSTRAP_SQL_PATH = 'packages/server/prisma/sql/00-bootstrap-roles.sql';

/** Raw text of the role bootstrap. Read as text on purpose: the assertions are about SQL shape. */
export const readBootstrapSql = (): string => readRepoFile(BOOTSTRAP_SQL_PATH);

/** Wrapper the Docker entrypoint and `pnpm db:bootstrap` both execute. */
export const BOOTSTRAP_WRAPPER_PATH = 'packages/server/prisma/sql/initdb/00-bootstrap-roles.sh';

export const readBootstrapWrapper = (): string => readRepoFile(BOOTSTRAP_WRAPPER_PATH);

/** Catalog-driven grant reconciler, run after every migration and after every restore. */
export const GRANTS_SQL_PATH = 'packages/server/prisma/sql/01-grants.sql';

export const readGrantsSql = (): string => readRepoFile(GRANTS_SQL_PATH);

/**
 * Healthcheck command of a service as one string, whatever syntax it was written in
 * (`CMD`/`CMD-SHELL` array or a bare shell string).
 */
export const healthcheckCommandOf = (service: ComposeService): string => {
  const test = service.healthcheck?.test;

  if (test === undefined) return '';
  return Array.isArray(test) ? test.join(' ') : test;
};

/** Numeric major version of a pinned image tag — `redis:8.8.1-alpine` → `8`. */
export const imageMajorOf = (service: ComposeService): number => {
  const tag = (service.image ?? '').split(':')[1] ?? '';
  return Number.parseInt(tag.replace(/^v/, ''), 10);
};

/**
 * Parses `docker-compose.yml` **without** interpolating environment variables: the invariants under
 * test are about what the file itself declares (`${VAR:-dev-default}`), not about what a particular
 * shell resolves it to. `docker compose config` would substitute them away.
 */
export const readComposeFile = (): ComposeFile => {
  const raw = readRepoFile(COMPOSE_PATH);
  return parseYaml(raw) as ComposeFile;
};

/** Services of a compose file as `[name, definition]` pairs, in declaration order. */
export const composeServices = (compose: ComposeFile): [string, ComposeService][] =>
  Object.entries(compose.services ?? {});

/**
 * Services that Compose starts when no profile is enabled. Compose has no way to *exclude* a service
 * from a profile, so the `minimal` set is expressed as "declares no `profiles` key" — every other
 * service opts in to a profile and therefore stays down until that profile is enabled.
 */
export const alwaysOnServices = (compose: ComposeFile): string[] =>
  composeServices(compose)
    .filter(([, service]) => service.profiles === undefined)
    .map(([name]) => name);

/** Normalises both accepted `environment` shapes to a plain map. */
export const environmentOf = (service: ComposeService): Record<string, string> => {
  const environment = service.environment;

  if (environment === undefined) return {};
  if (!Array.isArray(environment)) return environment;

  return Object.fromEntries(
    environment.map((entry) => {
      const separator = entry.indexOf('=');
      return separator === -1
        ? ([entry, ''] as const)
        : ([entry.slice(0, separator), entry.slice(separator + 1)] as const);
    }),
  );
};

const INTERPOLATION = /\$\{[^}]*\}/g;
// The sentinel is a NUL because it cannot occur inside a compose port mapping, while a space
// can. It is written as an escape rather than embedded as a raw byte: a literal NUL makes git
// treat the file as binary and survives no round-trip through an editor or a patch.
// eslint-disable-next-line no-control-regex -- deliberate NUL sentinel, see above
const MASK = /\u0000(\d+)\u0000/g;

/**
 * Splits the short port syntax `[host_ip:][published:]target[/protocol]` on colons, treating a
 * `${VAR:-default}` interpolation as one atom — its own colon must not look like a field separator.
 */
export const splitPortMapping = (mapping: string): string[] => {
  const interpolations: string[] = [];
  const masked = mapping.replace(INTERPOLATION, (match) => {
    interpolations.push(match);
    return `\u0000${interpolations.length - 1}\u0000`;
  });

  return masked
    .split(':')
    .map((part) => part.replace(MASK, (_, index: string) => interpolations[Number(index)] ?? ''));
};

/** Host interface a published port binds to, for both the short and the long port syntax. */
export const hostInterfaceOf = (mapping: string | ComposePortMapping): string | undefined => {
  if (typeof mapping !== 'string') return mapping.host_ip;

  // Only the three-field form pins the interface; anything shorter binds to every interface.
  const parts = splitPortMapping(mapping);
  return parts.length >= 3 ? parts[0] : undefined;
};

/** Host-side port of a mapping — the value a developer overrides to dodge a busy local port. */
export const publishedPortOf = (mapping: string | ComposePortMapping): string | undefined => {
  if (typeof mapping !== 'string') {
    return mapping.published === undefined ? undefined : String(mapping.published);
  }

  const parts = splitPortMapping(mapping);
  return parts.length >= 3 ? parts[1] : parts[0];
};

/** Named volumes (`name:/path`) mounted by a service; bind mounts (`./path:/path`) are ignored. */
export const namedVolumesOf = (service: ComposeService): string[] =>
  (service.volumes ?? [])
    .map((mount) => mount.split(':')[0] ?? '')
    .filter((source) => source !== '' && !source.startsWith('.') && !source.startsWith('/'));
