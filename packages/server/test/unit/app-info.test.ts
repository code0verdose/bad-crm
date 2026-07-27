import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_INFO } from '../../src/app-info.constant.js';

const packageVersion = (): string =>
  (
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { version: string }
  ).version;

describe('application identity', () => {
  /**
   * `/health` reports this version, and an operator uses it to tell which build is deployed. A
   * constant that drifts from `package.json` turns that answer into a lie precisely during an
   * upgrade, which is the one moment the question gets asked.
   */
  it('reports the version of the package it was built from', () => {
    expect(APP_INFO.version).toBe(packageVersion());
  });

  it('names the process, so a log aggregator can separate api from worker lines', () => {
    expect(APP_INFO.name).toBe('@bad-crm/server');
    expect(APP_INFO.role).toBe('api');
  });
});
