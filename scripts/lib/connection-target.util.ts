/**
 * Turning connection strings into something to connect to — and into something safe to print.
 *
 * Every function here is on the path between a secret-bearing variable and the terminal, so the
 * masking is not cosmetic: `pnpm check:services` output ends up pasted into issues and chat.
 */

export interface HostPort {
  readonly host: string;
  readonly port: number;
}

export interface PostgresTarget extends HostPort {
  readonly database: string;
  readonly user: string;
}

export interface RedisTarget extends HostPort {
  readonly password?: string;
}

const DEFAULT_PORTS: Record<string, number> = {
  'postgres:': 5432,
  'postgresql:': 5432,
  'redis:': 6379,
  'rediss:': 6380,
  'http:': 80,
  'https:': 443,
  'smtp:': 25,
  'smtps:': 465,
};

const parse = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

const portOf = (url: URL): number =>
  url.port === '' ? (DEFAULT_PORTS[url.protocol] ?? 0) : Number(url.port);

/** Host and port of any URL, with the scheme's default filled in. */
export const hostPortOf = (url: string): HostPort => {
  const parsed = parse(url);

  if (parsed === undefined) throw new Error(`not a URL: ${url}`);

  return { host: parsed.hostname, port: portOf(parsed) };
};

export const postgresTargetOf = (url: string): PostgresTarget => {
  const parsed = parse(url);

  if (parsed === undefined) throw new Error('DATABASE_URL is not a URL');

  return {
    host: parsed.hostname,
    port: portOf(parsed),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    user: decodeURIComponent(parsed.username),
  };
};

export const redisTargetOf = (url: string): RedisTarget => {
  const parsed = parse(url);

  if (parsed === undefined) throw new Error('REDIS_URL is not a URL');

  const password = decodeURIComponent(parsed.password);

  return {
    host: parsed.hostname,
    port: portOf(parsed),
    ...(password === '' ? {} : { password }),
  };
};

/** The same URL with the password removed — what goes on screen. */
export const maskUrl = (url: string): string => {
  const parsed = parse(url);

  if (parsed === undefined || parsed.password === '') return url;

  parsed.password = '';

  // `URL.toString()` re-adds the `@` for an empty password only when a username exists, which is
  // exactly the shape we want: `redis://@host` for `redis://:pw@host` reads as noise, so drop it.
  return parsed.toString().replace('://@', '://');
};

/**
 * Credentials embedded in free text — a driver error, a stack trace — with the password blanked.
 *
 * Applied to everything a check reports, because the one place a DSN reliably shows up uninvited is
 * inside the error message of the library that failed to open it.
 */
// The user part is `*`, not `+`: `scheme://:password@host` is the canonical shape for a Redis or
// SMTP URL that carries a password and no login. Requiring a username here let exactly that form
// through unredacted — the one shape most likely to appear in a self-host `.env`.
const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/@]*)@/gi;

export const redactSecrets = (text: string): string =>
  text.replace(CREDENTIALS_IN_URL, '$1$2:***@');
