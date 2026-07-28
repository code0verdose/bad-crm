import { describe, expect, it } from 'vitest';

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
