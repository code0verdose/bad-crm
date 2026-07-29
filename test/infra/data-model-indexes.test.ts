import { describe, expect, it } from 'vitest';

import { listRepoFiles, readRepoFile } from '../repo/repo-fixture.util.js';

/**
 * The index registry of `docs/architecture/data-model.md`, against the migrations that implement it.
 *
 * That document is the source of truth for names (CLAUDE.md, «Порядок источников истины»), which
 * makes an index it lists and the schema does not have worse than a missing line: the next author
 * reads the registry, believes the index is there, and writes a query plan around it.
 *
 * It happened. The registry listed `idx_organizations_owner (owner_id)`, and the migration that
 * added `organizations.owner_id` deliberately creates no such index — the referencing side is
 * searched by the composite `(id, owner_id)` whose leading column is the primary key, so
 * `pk_organizations` already serves it. The document was the thing that was wrong.
 *
 * Only tables the migrations actually create are checked. The document describes the whole model,
 * most of which is M2+ work, and holding it to a schema that does not exist yet would make this
 * suite a nuisance rather than a guard.
 */

const DATA_MODEL_PATH = 'docs/architecture/data-model.md';
const MIGRATIONS_DIR = 'packages/server/prisma/migrations';

interface Schema {
  readonly tables: Set<string>;
  readonly indexes: Set<string>;
}

/** Every table, index and named unique/primary constraint the committed migrations create. */
const schemaFromMigrations = (): Schema => {
  const tables = new Set<string>();
  const indexes = new Set<string>();

  for (const file of listRepoFiles(MIGRATIONS_DIR).filter((path) =>
    path.endsWith('migration.sql'),
  )) {
    const sql = readRepoFile(file)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    for (const [, name] of sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"/gi)) {
      tables.add(name ?? '');
    }

    for (const [, name] of sql.matchAll(
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"/gi,
    )) {
      indexes.add(name ?? '');
    }

    for (const [, name] of sql.matchAll(
      /\bADD\s+CONSTRAINT\s+"(\w+)"\s+(?:UNIQUE|PRIMARY\s+KEY)/gi,
    )) {
      indexes.add(name ?? '');
    }

    for (const [, name] of sql.matchAll(/\bCONSTRAINT\s+"(\w+)"\s+PRIMARY\s+KEY/gi)) {
      indexes.add(name ?? '');
    }
  }

  return { tables, indexes };
};

/**
 * A paragraph that recounts what the document used to say is history, not a declaration.
 *
 * The registry of the identity group carries such a paragraph: it names `idx_sessions_user_family`
 * and `idx_sessions_expires` in order to state that those were the *previous*, tenant-less names,
 * corrected while EPIC-006 was implemented. Reading them as declarations would demand that the
 * schema grow the very indexes the paragraph says were wrong.
 */
const HISTORICAL_PARAGRAPH = /Предыдущая редакция|переименован|устаревш/i;

/** Index names the document declares, in the `` `idx_…` `` / `` `uq_…` `` / `` `pk_…` `` form. */
const indexesNamedInDoc = (markdown: string): Set<string> =>
  new Set(
    markdown
      // Blank lines *and* the start of a top-level bullet: the registry is one unbroken list, so a
      // paragraph split alone would put a historical note and the bullet below it in one chunk.
      .split(/\n\s*\n|\n(?=- )/)
      .filter((paragraph) => !HISTORICAL_PARAGRAPH.test(paragraph))
      .flatMap((paragraph) => [...paragraph.matchAll(/`((?:idx|uq|pk)_\w+)/g)])
      .map((match) => match[1] ?? '')
      .filter(Boolean),
  );

/** `idx_sessions_org_expires` belongs to `sessions`; `pk_organizations` to `organizations`. */
const tableOf = (index: string, tables: ReadonlySet<string>): string | undefined =>
  [...tables]
    .filter(
      (table) =>
        index.startsWith(`idx_${table}_`) ||
        index.startsWith(`uq_${table}_`) ||
        index === `pk_${table}`,
    )
    // Longest match wins, so `user_roles` is not mistaken for `users`.
    .sort((left, right) => right.length - left.length)[0];

describe('the index registry of data-model.md and the migrations', () => {
  const schema = schemaFromMigrations();
  const document = readRepoFile(DATA_MODEL_PATH);
  const declared = indexesNamedInDoc(document);

  it('reads a schema to compare against', () => {
    expect(schema.tables.size).toBeGreaterThan(0);
    expect(schema.indexes.size).toBeGreaterThan(0);
    expect(declared.size).toBeGreaterThan(0);
  });

  it('declares no index the implemented tables do not have', () => {
    const phantom = [...declared]
      .filter((index) => tableOf(index, schema.tables) !== undefined)
      .filter((index) => !schema.indexes.has(index))
      .sort();

    expect(
      phantom,
      'the registry names indexes that no migration creates — a reader will plan queries around them',
    ).toEqual([]);
  });

  /**
   * The other direction, narrowed to `idx_` on purpose.
   *
   * A secondary index is a performance decision, and the registry is where this project records
   * them — an index added to a migration and to nothing else is a decision no reviewer sees. The
   * primary keys and the composite `uq_<table>_org_id` keys that exist only so a child table can
   * carry a tenant-safe foreign key are mechanical, and listing them would bury the decisions.
   */
  it('names every secondary index the implemented tables do have', () => {
    const undocumented = [...schema.indexes]
      .filter((index) => index.startsWith('idx_'))
      .filter((index) => tableOf(index, schema.tables) !== undefined)
      .filter((index) => !declared.has(index))
      .sort();

    expect(
      undocumented,
      'the schema has indexes the source of truth for names never mentions',
    ).toEqual([]);
  });
});
