import { describe, expect, it } from 'vitest';

import { readRepoFile } from '../repo/repo-fixture.util.js';

/**
 * The field registry of `docs/architecture/data-model.md`, against the Prisma schema.
 *
 * The document is the source of truth for names (CLAUDE.md, «Порядок источников истины»), and its
 * entity tables list the key fields of every model. A field it names and the schema does not have is
 * the same defect the index gate next door was written for, one column deeper: the next author reads
 * the registry, believes the field is there, and designs a query or a serializer around it.
 *
 * **It happened.** The registry gave `Permission` a `description` column. There is none, and there
 * will not be: the catalogue carries `descriptionKey`, an i18n key, because the text is translated
 * rather than stored (`rules/i18n.mdc`). The same row also called `key` unique when it is the
 * primary key. The index gate could not see either — it compares index names and nothing else.
 *
 * **One direction only, deliberately.** «The document names a field that does not exist» is exact.
 * The reverse — «the schema has a field the document does not name» — is not: those tables list
 * *key* fields, abbreviate with `?` and `…`, and describe M3+ models that no migration has created.
 * A gate that demanded completeness would be red on correct prose, and a gate people argue with is a
 * gate people delete. What the reverse direction would catch is recorded as open rather than
 * pretended: `docs/brain/2026-08-16--three-holes-that-only-a-measurement-found.md`.
 */

const DATA_MODEL_PATH = 'docs/architecture/data-model.md';
const SCHEMA_PATH = 'packages/server/prisma/schema.prisma';

/** Every Prisma model, with the field names it declares. */
const schemaModels = (): Map<string, Set<string>> => {
  const models = new Map<string, Set<string>>();
  const source = readRepoFile(SCHEMA_PATH);

  for (const [, name, body] of source.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const fields = new Set<string>();

    for (const line of (body ?? '').split('\n')) {
      const field = /^\s{2}(\w+)\s+\S/.exec(line);

      if (field?.[1] !== undefined) fields.add(field[1]);
    }

    if (name !== undefined) models.set(name, fields);
  }

  return models;
};

/**
 * Field names the document claims for one entity.
 *
 * Read out of the back-ticked spans of the «Ключевые поля» column, which is where names live in
 * these tables. Two things are dropped first, and both were found by this gate reporting them:
 *
 * - **anything in parentheses** — those are examples of the *value*, not names of fields:
 *   `key @id (`task:delete`, формат `<resource>:<action>`)` claims one field and illustrates it
 *   with two spans that are not fields at all;
 * - **spans that cannot be an identifier** — a type, an annotation, a phrase (`@id`, `Bool`,
 *   `DateTime`, `→`).
 */
const NOT_A_FIELD = /^(?:@|[A-Z])|[^A-Za-z0-9?]/;

const documentedFields = (): Map<string, string[]> => {
  const claimed = new Map<string, string[]>();

  for (const line of readRepoFile(DATA_MODEL_PATH).split('\n')) {
    const row = /^\|\s*`(\w+)`\s*\|[^|]*\|([^|]*)\|/.exec(line);

    if (row?.[1] === undefined || row[2] === undefined) continue;

    const fields = [...row[2].replaceAll(/\([^)]*\)/g, '').matchAll(/`([^`]+)`/g)]
      .map(([, span]) => (span ?? '').trim().replace(/\?$/, ''))
      .filter((span) => span !== '' && !NOT_A_FIELD.test(span));

    if (fields.length > 0) claimed.set(row[1], fields);
  }

  return claimed;
};

describe('the field registry of data-model.md and the Prisma schema', () => {
  it('reads both sides, so the comparison below is not vacuous', () => {
    const models = schemaModels();
    const documented = documentedFields();

    expect(models.size).toBeGreaterThan(10);
    expect(models.get('Permission')?.has('isDangerous')).toBe(true);
    expect(documented.size).toBeGreaterThan(10);
    expect(documented.get('Permission')?.length).toBeGreaterThan(0);
  });

  it('names no field the implemented models do not have', () => {
    const models = schemaModels();
    const phantom: string[] = [];

    for (const [entity, fields] of documentedFields()) {
      const model = models.get(entity);

      // Only models a migration has actually created: the document describes the whole product,
      // most of which is M3+, and holding it to a schema that does not exist yet would make this
      // suite a nuisance rather than a guard — the same boundary the index gate draws.
      if (model === undefined) continue;

      for (const field of fields) {
        if (!model.has(field)) phantom.push(`${entity}.${field}`);
      }
    }

    expect(
      phantom,
      'the document is the source of truth for names: a field it lists and the schema lacks is read as real by the next author',
    ).toEqual([]);
  });
});
