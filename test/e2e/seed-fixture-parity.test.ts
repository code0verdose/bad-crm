import { describe, expect, it } from 'vitest';

import {
  SEED_ORGANIZATIONS as E2E_ORGANIZATIONS,
  SEED_PASSWORD as E2E_PASSWORD,
} from '../../packages/e2e/fixtures/seed-data.js';
import {
  SEED_ORGANIZATIONS as SERVER_ORGANIZATIONS,
  SEED_PASSWORD as SERVER_PASSWORD,
} from '../../packages/server/scripts/seed-data.constant.js';
import { recordRead } from '../repo/repo-fixture.util.js';

/**
 * The two declarations of the seed say the same thing.
 *
 * `packages/e2e` may not import product sources — an end-to-end scenario that imported them could
 * pass against code that is not deployed — so the fixture it uses is a copy of the one the seed
 * applies. A copy is a promise; this is the gate that makes it a fact.
 *
 * The failure it exists for is quiet: somebody renames an organization or changes the seed password
 * on the server side, the seed keeps working, the e2e suite keeps compiling, and every scenario
 * fails at sign-in with «invalid credentials» — pointing at authentication, which is the one thing
 * that is not broken.
 */

// Imported rather than read, so the registry that feeds `//#test:repo` inputs has to be told.
recordRead('packages/e2e/fixtures/seed-data.ts');
recordRead('packages/server/scripts/seed-data.constant.ts');

describe('the seed fixture matches the seed', () => {
  it('declares the same organizations, field for field', () => {
    expect(E2E_ORGANIZATIONS).toEqual(SERVER_ORGANIZATIONS);
  });

  it('signs in with the same password', () => {
    expect(E2E_PASSWORD).toBe(SERVER_PASSWORD);
  });

  /**
   * CONTROL: both sides are non-empty. `toEqual` over two empty arrays is the shape this assertion
   * takes when an export is renamed and the import resolves to something else — a green comparison
   * of nothing against nothing.
   */
  it('CONTROL: compares a non-empty fixture', () => {
    expect(SERVER_ORGANIZATIONS.length).toBeGreaterThanOrEqual(2);
    expect(E2E_ORGANIZATIONS.length).toBe(SERVER_ORGANIZATIONS.length);
  });
});
