import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROJECT_ROLES,
  PROJECT_STATUSES,
  PROJECT_VISIBILITIES,
} from '@/domain/project/project.enums.js';

/**
 * The closed lists of the project domain exist twice — in `project.enums.ts` and in the `CHECK`
 * constraints of the migration that created the tables — and nothing but this file holds the two
 * copies together. A value added to one and not the other is a request the validator accepts and
 * the database refuses, answered `500` at the row.
 */

const MIGRATIONS = join(import.meta.dirname, '../../../../prisma/migrations');

const migrationSql = (): string => {
  const directory = readdirSync(MIGRATIONS).find((name) =>
    name.endsWith('_projects_and_project_members'),
  );

  if (directory === undefined) throw new Error('the projects migration is not in the tree');

  return readFileSync(join(MIGRATIONS, directory, 'migration.sql'), 'utf8');
};

/** The quoted values of `CONSTRAINT "<name>" CHECK ("<column>" IN (...))`, in order. */
const checkList = (sql: string, constraint: string): string[] => {
  const match = new RegExp(
    `CONSTRAINT "${constraint}"\\s+CHECK \\("[a-z_]+" IN \\(([^)]*)\\)\\)`,
  ).exec(sql);

  if (match?.[1] === undefined) throw new Error(`${constraint} is not a CHECK … IN (…) constraint`);

  return [...match[1].matchAll(/'([^']*)'/g)].map((value) => value[1] ?? '');
};

describe('the closed lists of the project domain', () => {
  const sql = migrationSql();

  it('CONTROL: the parser reads a list out of the migration at all', () => {
    expect(checkList(sql, 'ck_projects_status').length).toBeGreaterThan(0);
  });

  it('agrees with ck_projects_status', () => {
    expect(checkList(sql, 'ck_projects_status')).toEqual([...PROJECT_STATUSES]);
  });

  it('agrees with ck_projects_visibility', () => {
    expect(checkList(sql, 'ck_projects_visibility')).toEqual([...PROJECT_VISIBILITIES]);
  });

  it('agrees with ck_project_members_role', () => {
    expect(checkList(sql, 'ck_project_members_role')).toEqual([...PROJECT_ROLES]);
  });

  it('names the defaults the migration writes', () => {
    expect(sql).toContain(`"status"          TEXT           NOT NULL DEFAULT 'ACTIVE'`);
    expect(sql).toContain(`"visibility"      TEXT           NOT NULL DEFAULT 'PUBLIC_ORG'`);
    expect(sql).toContain(`"project_role"    TEXT           NOT NULL DEFAULT 'MEMBER'`);
  });
});
