import { describe, expect, it } from 'vitest';

import { clientEnvSchema } from '../../packages/client/src/shared/config/env.schema.js';
import {
  SECRET_BEARING_ENV_KEYS,
  SERVER_ENV_KEYS,
} from '../../packages/server/src/infrastructure/bootstrap/env.schema.js';
import { readRepoFile } from '../repo/repo-fixture.util.js';
import {
  ENV_EXAMPLE_PATH,
  TOOLING_ENV_KEYS,
  composeInterpolatedVariables,
  readEnvExample,
} from './env-example.util.js';

const CLIENT_ENV_KEYS = Object.keys(clientEnvSchema.shape);

const exampleEntries = readEnvExample();
const exampleKeys = exampleEntries.map((entry) => entry.key);

/**
 * Everything that legitimately belongs in the template: what the server parses, what the browser
 * bundle parses, what `docker-compose.yml` interpolates, and what the compose CLI itself reads.
 */
const expectedKeys = [
  ...SERVER_ENV_KEYS,
  ...CLIENT_ENV_KEYS,
  ...composeInterpolatedVariables(),
  ...TOOLING_ENV_KEYS,
];

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

describe('.env.example is the single list of every variable', () => {
  it('declares no variable twice', () => {
    const duplicates = exampleKeys.filter((key, index) => exampleKeys.indexOf(key) !== index);

    expect(duplicates).toEqual([]);
  });

  it('documents every variable the server schema declares', () => {
    expect(SERVER_ENV_KEYS.filter((key) => !exampleKeys.includes(key))).toEqual([]);
  });

  it('documents every variable the browser bundle reads', () => {
    expect(CLIENT_ENV_KEYS.filter((key) => !exampleKeys.includes(key))).toEqual([]);
  });

  it('documents every variable docker-compose.yml interpolates', () => {
    expect(composeInterpolatedVariables().filter((key) => !exampleKeys.includes(key))).toEqual([]);
  });

  it('declares nothing that no schema, compose file or tool actually reads', () => {
    expect(exampleKeys.filter((key) => !expectedKeys.includes(key))).toEqual([]);
  });

  it('matches the union exactly, in both directions', () => {
    expect(unique(exampleKeys)).toEqual(unique(expectedKeys));
  });
});

describe('.env.example contains no real secret', () => {
  /** `postgres://user:password@host/db` → `user:password`; undefined when the URL carries none. */
  const credentialsOf = (value: string): string | undefined =>
    /^[a-z][a-z0-9+.-]*:\/\/([^@/]+)@/i.exec(value)?.[1];

  /** A value is safe to commit when it is empty, a placeholder, or carries no credential at all. */
  const isSafeToCommit = (value: string): boolean => {
    if (value === '' || value.includes('CHANGE_ME')) return true;

    const credentials = credentialsOf(value);

    // A connection string without a credential part — `redis://localhost:6379` — is an address.
    return credentials === undefined || credentials.includes('CHANGE_ME');
  };

  it('never commits a real value for a secret-bearing variable', () => {
    const offenders = exampleEntries
      .filter((entry) => (SECRET_BEARING_ENV_KEYS as readonly string[]).includes(entry.key))
      .filter((entry) => !isSafeToCommit(entry.value))
      .map((entry) => entry.key);

    expect(offenders).toEqual([]);
  });

  it('never commits a real password or key for a compose service', () => {
    const offenders = exampleEntries
      .filter((entry) => /PASSWORD|MASTER_KEY|ROOT_USER|ROOT_PASSWORD/.test(entry.key))
      .filter((entry) => !isSafeToCommit(entry.value))
      .map((entry) => entry.key);

    expect(offenders).toEqual([]);
  });

  it('tells the operator how to generate the two secrets that have no usable placeholder', () => {
    const raw = readRepoFile(ENV_EXAMPLE_PATH);

    expect(raw).toContain('openssl rand -base64 32');
    expect(raw).toContain('openssl rand -base64 48');
  });

  it('never ships a real .env: only the template is committed', () => {
    const gitignore = readRepoFile('.gitignore');

    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^!\.env\.example$/m);
  });
});

describe('the browser bundle gets no secret', () => {
  it('gives no VITE_ name to a variable the server treats as a secret', () => {
    const leaked = exampleKeys
      .filter((key) => key.startsWith('VITE_'))
      .filter(
        (key) =>
          SECRET_BEARING_ENV_KEYS.some((secret) => key.includes(secret)) ||
          /PASSWORD|SECRET|MASTER_KEY|ACCESS_KEY|ENCRYPTION/.test(key),
      );

    expect(leaked).toEqual([]);
  });

  it('keeps the client schema a strict subset of the VITE_ namespace', () => {
    expect(CLIENT_ENV_KEYS.filter((key) => !key.startsWith('VITE_'))).toEqual([]);
  });

  it('never lets a server variable and a client variable share a name', () => {
    const overlap = CLIENT_ENV_KEYS.filter((key) =>
      (SERVER_ENV_KEYS as readonly string[]).includes(key),
    );

    expect(overlap).toEqual([]);
  });
});
