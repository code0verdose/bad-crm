import { describe, expect, it } from 'vitest';

import {
  CLIENT_ENV_PREFIX,
  clientEnvSchema,
  loadClientEnv,
} from '../../src/shared/config/index.js';

/**
 * Names that must never appear in a browser bundle. If one of these ever shows up in the client
 * schema, the value it holds is being shipped to every visitor (rules/security.mdc, rule 3).
 */
const SERVER_ONLY_SECRETS = [
  'JWT_SECRET',
  'APP_ENCRYPTION_KEY',
  'MEILI_MASTER_KEY',
  'S3_SECRET_KEY',
  'S3_ACCESS_KEY',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'REDIS_URL',
  'SMTP_URL',
  'POSTGRES_PASSWORD',
  'APP_MIGRATOR_PASSWORD',
  'APP_USER_PASSWORD',
  'APP_AUTH_PASSWORD',
  'MINIO_ROOT_PASSWORD',
];

const clientKeys = (): string[] => Object.keys(clientEnvSchema.shape);

describe('client environment', () => {
  it('exposes only VITE_-prefixed variables, the only ones Vite will inline', () => {
    expect(clientKeys().filter((key) => !key.startsWith(CLIENT_ENV_PREFIX))).toEqual([]);
  });

  it('carries no server secret, under its own name or behind a VITE_ prefix', () => {
    const leaked = clientKeys().filter((key) =>
      SERVER_ONLY_SECRETS.some((secret) => key.includes(secret)),
    );

    expect(leaked).toEqual([]);
  });

  it('falls back to a same-origin API path when nothing is configured', () => {
    expect(loadClientEnv({})).toEqual({ VITE_API_BASE_URL: '/api/v1' });
  });

  it('takes the configured API base URL', () => {
    expect(loadClientEnv({ VITE_API_BASE_URL: 'https://api.example.com/v1' })).toEqual({
      VITE_API_BASE_URL: 'https://api.example.com/v1',
    });
  });

  it('ignores the rest of the environment instead of forwarding it into the app', () => {
    // A server-only secret is deliberately present in the input: the assertion below proves it is
    // dropped rather than forwarded into the client bundle. The value is a dummy, marked in both
    // exemption syntaxes because scan-secrets.sh reads one and gitleaks the other.
    const serverOnlySecret = 'leaked'; // scan-secrets:allow gitleaks:allow
    expect(loadClientEnv({ VITE_API_BASE_URL: '/api/v1', JWT_SECRET: serverOnlySecret })).toEqual({
      VITE_API_BASE_URL: '/api/v1',
    });
  });

  it('rejects an empty API base URL rather than silently calling the current page', () => {
    expect(() => loadClientEnv({ VITE_API_BASE_URL: '' })).toThrow();
  });
});

/**
 * `min(1)` accepted anything non-empty, including values that quietly redirect every API call —
 * and every bearer token attached to it — somewhere else. `//evil.example.com` is the sharp one:
 * a browser reads a protocol-relative URL as "another origin, same scheme", so it never looks
 * like an absolute URL to a naive check but behaves exactly like one.
 */
describe('VITE_API_BASE_URL is a same-origin path or an http(s) URL', () => {
  it.each([
    '/api/v1',
    '/',
    '/api/v1/',
    'https://api.example.com/v1',
    'http://localhost:3000/api/v1',
  ])('accepts %o', (value) => {
    expect(loadClientEnv({ VITE_API_BASE_URL: value }).VITE_API_BASE_URL).toBe(value);
  });

  it.each([
    ['//evil.example.com/api', 'protocol-relative: a different origin that reads as a path'],
    [
      '/\\evil.example.com/api',
      'protocol-relative spelled with a backslash: browsers read \\ as /',
    ],
    [
      '/\\/\\evil.example.com',
      'the same trick doubled, in case only the first slash is normalised',
    ],
    ['/\t/evil.example.com/api', 'the URL parser strips ASCII tab, so this is protocol-relative'],
    ['/\n/evil.example.com/api', 'same for LF'],
    ['/\r/evil.example.com/api', 'same for CR'],
    ['javascript:alert(1)', 'a script URL'],
    ['data:text/html,<script></script>', 'a data URL'],
    ['ftp://files.example.com', 'a scheme no browser will fetch JSON over'],
    ['api/v1', 'a relative path, resolved against whatever route is open'],
    ['   ', 'whitespace, which min(1) called valid'],
  ])('rejects %o — %s', (value) => {
    expect(() => loadClientEnv({ VITE_API_BASE_URL: value })).toThrow(/VITE_API_BASE_URL/);
  });
});
