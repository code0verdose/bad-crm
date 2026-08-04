import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { shippedMigrationNames } from '../../../src/infrastructure/persistence/prisma/shipped-migrations.util.js';

const directoryContaining = (entries: readonly string[]): string => {
  const root = mkdtempSync(join(tmpdir(), 'migrations-'));

  for (const entry of entries) {
    if (entry.endsWith('.toml')) writeFileSync(join(root, entry), '', 'utf8');
    else mkdirSync(join(root, entry));
  }

  return root;
};

describe('shippedMigrationNames', () => {
  it('lists the migration folders, sorted the way Prisma orders them', () => {
    const root = directoryContaining(['20260101_b', '20250101_a']);

    expect(shippedMigrationNames(root)).toEqual(['20250101_a', '20260101_b']);
  });

  /** `migration_lock.toml` sits beside the folders and is not a migration. */
  it('ignores the files beside them', () => {
    const root = directoryContaining(['20250101_a', 'migration_lock.toml']);

    expect(shippedMigrationNames(root)).toEqual(['20250101_a']);
  });

  /**
   * A build that cannot find its own migrations is broken. Logging and carrying on would leave the
   * readiness check silently disabled — an instance reporting itself ready while the database has
   * the wrong shape, which is the failure this whole probe exists to catch.
   */
  it('throws rather than pretending there are none', () => {
    expect(() => shippedMigrationNames(join(tmpdir(), 'no-such-directory-here'))).toThrow();
  });

  /** CONTROL: an empty directory is a legitimate answer, and not the same as an unreadable one. */
  it('CONTROL: answers with nothing for an empty directory', () => {
    expect(shippedMigrationNames(directoryContaining([]))).toEqual([]);
  });
});
