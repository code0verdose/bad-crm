import { UserStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { DIRECTORY_STATUSES } from '@/application/iam/ports/employee-directory-repository.port.js';
import {
  TENANT_TABLES,
  tenantTablesFromSchema,
} from '@/infrastructure/persistence/prisma/tenant-tables.constant.js';

/**
 * The registry is the list every isolation test is generated from. If it falls behind the schema,
 * a table stops being tested and nothing else notices — the suite still passes, over fewer tables.
 */
describe('the tenant table registry', () => {
  it('lists exactly the tenant-scoped models of the schema', () => {
    const fromSchema = tenantTablesFromSchema().map((entry) => entry.table);

    expect([...fromSchema].sort()).toEqual(Object.keys(TENANT_TABLES).sort());
  });

  it('names the same Prisma model the schema does', () => {
    for (const { table, model } of tenantTablesFromSchema()) {
      expect(TENANT_TABLES[table as keyof typeof TENANT_TABLES]?.model, table).toBe(model);
    }
  });

  /**
   * The flag the migration suite asserts `deleted_at` from, held against the schema it describes.
   *
   * Either direction is a real defect. A table marked soft-deleted without the column makes the
   * global `deletedAt IS NULL` filter of `docs/architecture/data-model.md` read a column that is not
   * there; a table with the column and the flag off makes the migration suite stop requiring it, and
   * the next table to lose the column ships unnoticed.
   */
  it('agrees with the schema about which tables are softly deleted', () => {
    for (const { table, softDeleted } of tenantTablesFromSchema()) {
      expect(TENANT_TABLES[table as keyof typeof TENANT_TABLES]?.softDeleted, table).toBe(
        softDeleted,
      );
    }
  });

  it('marks at least one table each way, or the assertion above is vacuous', () => {
    const flags = Object.values(TENANT_TABLES).map((spec) => spec.softDeleted);

    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  /**
   * The same, for the pair of row stamps. A journal has `occurred_at` and no `updated_at` — it is
   * never updated, so a column saying when it last was would have one possible value. The flag is
   * what the migration suite reads to decide whether to require the pair, so it has to describe the
   * schema rather than somebody's memory of it.
   */
  it('agrees with the schema about which tables carry created_at/updated_at', () => {
    for (const { table, rowTimestamps } of tenantTablesFromSchema()) {
      expect(TENANT_TABLES[table as keyof typeof TENANT_TABLES]?.rowTimestamps, table).toBe(
        rowTimestamps,
      );
    }
  });

  it('marks at least one table each way there too', () => {
    const flags = Object.values(TENANT_TABLES).map((spec) => spec.rowTimestamps);

    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  it('reads the tenant root off its own primary key', () => {
    expect(TENANT_TABLES.organizations.tenantColumn).toBe('id');
  });

  it('never grants TRUNCATE, which ignores row level security entirely', () => {
    for (const [table, spec] of Object.entries(TENANT_TABLES)) {
      expect(spec.appUserPrivileges as readonly string[], table).not.toContain('TRUNCATE');
    }
  });

  it('gives every tenant table at least a read privilege, or the entry is dead weight', () => {
    for (const [table, spec] of Object.entries(TENANT_TABLES)) {
      expect(spec.appUserPrivileges as readonly string[], table).toContain('SELECT');
    }
  });
});

/**
 * The lists `application` restates because it may not import the driver.
 *
 * `rules/hexagonal-backend.mdc` keeps Prisma out of `application`, so a couple of enums are written
 * out there by hand. A restatement is a copy, and a copy drifts — this is the check that makes the
 * drift a failing test rather than a filter that silently stops matching a status somebody added.
 */
describe('what application restates from the datamodel', () => {
  it('lists exactly the account statuses the schema declares', () => {
    // From the generated client, which is the datamodel compiled: comparing against a second
    // hand-written list would only prove that two copies agree with each other.
    expect([...DIRECTORY_STATUSES].sort()).toEqual(Object.values(UserStatus).sort());
  });
});
