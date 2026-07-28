import { describe, expect, it } from 'vitest';

import { SystemIdGeneratorAdapter } from '@/infrastructure/platform/system-id-generator.adapter.js';

/**
 * Two kinds of identifier, and the reason they are two.
 *
 * `next()` is a correlation id — a request, a job — and is ULID: sortable by creation time and
 * unambiguous when read out of a support ticket. `uuid()` is an entity key, and every `id` column
 * of `docs/architecture/data-model.md` is `uuid`: a ULID handed to one is rejected by PostgreSQL as
 * `22P02`, at the end of a transaction that has already written other rows.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

const ids = new SystemIdGeneratorAdapter();

describe('SystemIdGeneratorAdapter', () => {
  it('produces a ULID for a correlation identifier', () => {
    expect(ids.next()).toMatch(ULID);
  });

  it('produces a UUID for an entity key, which is what the columns are', () => {
    expect(ids.uuid()).toMatch(UUID);
  });

  /**
   * The version nibble, pinned on purpose.
   *
   * `docs/architecture/data-model.md` prefers UUIDv7 for the schema and settles on
   * `gen_random_uuid()` — v4 — until an installation can be relied on to provide it. The one key
   * this adapter generates is an organization id, where insert locality buys nothing, so it follows
   * the column default rather than getting ahead of it. If this ever reads `7`, that schema-wide
   * decision has been taken and `rules/tenancy-rls.mdc` rule 17 has to be revisited in the same
   * change instead of drifting apart from the code again.
   */
  it('produces a version 4 uuid, the format the schema default uses today', () => {
    expect(ids.uuid()[14]).toBe('4');
  });

  it('never returns the same value twice from either', () => {
    expect(new Set([ids.next(), ids.next()]).size).toBe(2);
    expect(new Set([ids.uuid(), ids.uuid()]).size).toBe(2);
  });

  /**
   * The distinction is the whole point of the second method: a ULID is not a UUID, so the two must
   * not be interchangeable at a call site that writes a primary key.
   */
  it('keeps the two shapes apart, so one cannot stand in for the other', () => {
    expect(ids.next()).not.toMatch(UUID);
    expect(ids.uuid()).not.toMatch(ULID);
  });
});
