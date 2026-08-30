import { describe, expect, it } from 'vitest';

import { readRepoFile } from '../repo/repo-fixture.util.js';

/**
 * The other direction of `data-model-fields.test.ts`: what the schema has and the document omits.
 *
 * `docs/architecture/data-model.md` is the source of truth for names (CLAUDE.md, «Порядок
 * источников истины»). The neighbouring gate reads it in the exact direction — a field the document
 * names must exist — and says in writing why it stops there. This file closes the direction it left
 * open, and closes it for the *implemented* schema only, because that is where the omission is a
 * defect rather than a document describing a product that has not been built: a table arrives with
 * an epic, nobody appends its row, and a month later the registry of names does not know half of
 * the schema. It had already started: `UserPermissionOverride.grantedAt` shipped in
 * `20260805130000_user_permission_overrides` and was named nowhere in the document.
 *
 * **What counts as «described», and why it is this and nothing looser.** A model is described by a
 * *row of a four-column entity table* whose first cell is a single backticked identifier — the
 * tables of «Карта сущностей», which is where this document registers names. Nothing else counts,
 * and the reason is measured rather than assumed: every one of the fifteen implemented models is
 * also named somewhere in the prose, in a `mermaid` block or in a SQL example, so a detector that
 * accepted any mention would be satisfied by a document from which every entity table had been
 * deleted. That is the same trap `test/rules/declared-checks.util.ts` documents for the «Механизм»
 * column of a rule: the prose of a document argues, only its tables declare.
 *
 * **What counts as a column.** A scalar or enum field of a Prisma model. A back-relation
 * (`user.sessions`, `organization.auditLogs`) is not a column, it is a navigation property Prisma
 * synthesises from the other side's foreign key; the naive reading that treats every `model` line
 * as a column reports twenty-two of them and is wrong about all twenty-two.
 *
 * **Five columns are exempt, and the document is what exempts them.** `id`, `organizationId`,
 * `createdAt`, `updatedAt` and `deletedAt` are declared once for the whole model in «Принципы
 * моделирования» — «PK — `uuid` во всех таблицах», «`organizationId` присутствует на **каждой**
 * доменной таблице», «`createdAt` … `updatedAt` …», and a named list of the tables that carry
 * `deletedAt`. Demanding them again in every row would make ninety per cent of the findings a
 * request to repeat a convention the document already states, and a gate whose findings are noise
 * is a gate somebody deletes.
 */

const DATA_MODEL_PATH = 'docs/architecture/data-model.md';
const SCHEMA_PATH = 'packages/server/prisma/schema.prisma';

/**
 * Columns the document declares once, for every table, in «Принципы моделирования».
 *
 * Not a convenience list: each one is a sentence of that section, and re-listing them per row is
 * what the section exists to avoid.
 */
const CONVENTION_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'organizationId',
  'createdAt',
  'updatedAt',
  'deletedAt',
]);

const SCALAR_TYPE = /^(?:String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes)(?:\[\])?\??$/;

/** Every Prisma model with the columns it actually persists — scalars and enums, no relations. */
const schemaColumns = (source: string): Map<string, string[]> => {
  const enums = new Set([...source.matchAll(/^enum\s+(\w+)\s*\{/gm)].map(([, name]) => name));
  const models = new Map<string, string[]>();

  for (const [, name, body] of source.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const columns: string[] = [];

    for (const line of (body ?? '').split('\n')) {
      const field = /^ {2}(\w+)\s+(\S+)/.exec(line);

      if (field?.[1] === undefined || field[2] === undefined) continue;

      const bare = field[2].replaceAll(/[[\]?]/g, '');

      if (SCALAR_TYPE.test(field[2]) || enums.has(bare)) columns.push(field[1]);
    }

    if (name !== undefined) models.set(name, columns);
  }

  return models;
};

/**
 * Cells of one markdown table row, split on unescaped pipes.
 *
 * `\|` inside a cell is a literal pipe — the document writes unions that way
 * (`status ACTIVE\|SUSPENDED\|INVITED`, `effect ALLOW\|DENY`). Splitting on every `|` truncates
 * those cells at the first union and loses every name written after it; measured, that alone
 * accounts for twenty-seven of the eighty-one findings the naive version reports.
 */
const cellsOf = (line: string): string[] =>
  line
    .trim()
    .split(/(?<!\\)\|/)
    .slice(1, -1);

/**
 * Names each entity row claims for its model: every backticked span of the «Ключевые поля» and the
 * relations column, broken into identifier-shaped tokens.
 *
 * Both columns, because a foreign key is often named only on the relations side. Tokens rather than
 * whole spans, because a cell writes a field together with its type or its union
 * (`` `permissionsVersion Int` ``, `` `teamRole MEMBER\|LEAD` ``). Parentheses are *not* stripped
 * here, unlike in `data-model-fields.test.ts`: that gate reads spans as claims and must not read a
 * value example as one, while this gate only asks whether a name is present — a column named inside
 * a check-constraint example is still named.
 */
const entityRows = (markdown: string): Map<string, Set<string>> => {
  const rows = new Map<string, Set<string>>();

  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;

    const cells = cellsOf(line);

    if (cells.length !== 4) continue;

    const entity = /^\s*`(\w+)`\s*$/.exec(cells[0] ?? '');

    if (entity?.[1] === undefined) continue;

    const named = rows.get(entity[1]) ?? new Set<string>();

    for (const [, span] of `${cells[2] ?? ''} ${cells[3] ?? ''}`.matchAll(/`([^`]+)`/g)) {
      for (const token of (span ?? '').split(/[^A-Za-z0-9_]+/)) {
        if (/^[a-z][A-Za-z0-9_]*$/.test(token)) named.add(token);
      }
    }

    rows.set(entity[1], named);
  }

  return rows;
};

/**
 * A document shaped like the real one, in which exactly one model is registered and three are only
 * mentioned — in prose, in a `mermaid` block and in a SQL example.
 *
 * This is the control the detector dies with: loosen `entityRows` into «a backticked PascalCase
 * token anywhere» and the three impostors below arrive as declarations, and every assertion in this
 * file starts passing over a document that declares nothing.
 */
const FIXTURE = [
  '| Сущность | Метка | Ключевые поля | Связи |',
  '|---|---|---|---|',
  '| `Widget` | [T] | `label`, `state DRAFT\\|LIVE`, `ownerId` | → `Gadget` |',
  '',
  'Подробности про `Gadget` живут в прозе, и это не объявление.',
  '',
  '```mermaid',
  'erDiagram',
  '  Sprocket ||--o{ Widget : has',
  '```',
  '',
  '```sql',
  'SELECT * FROM cogs; -- модель `Cog`',
  '```',
  '',
  '| Таблица | Почему без RLS |',
  '|---|---|',
  '| `Flange` | двухколоночная таблица — не реестр сущностей |',
].join('\n');

describe('what the Prisma schema has and data-model.md never names', () => {
  const models = schemaColumns(readRepoFile(SCHEMA_PATH));
  const documented = entityRows(readRepoFile(DATA_MODEL_PATH));

  it('reads a registry that only entity tables can write into', () => {
    const parsed = entityRows(FIXTURE);

    expect([...parsed.keys()]).toEqual(['Widget']);
    expect(parsed.get('Widget')).toEqual(new Set(['label', 'state', 'ownerId']));
  });

  it('reads columns and not the relations Prisma synthesises', () => {
    const parsed = schemaColumns(
      [
        'enum Mood {\n  UP\n  DOWN\n}',
        'model Widget {',
        '  id       String @id',
        '  label    String',
        '  mood     Mood',
        '  ownerId  String @map("owner_id")',
        '  owner    Gadget @relation(fields: [ownerId], references: [id])',
        '  parts    Part[]',
        '}',
      ].join('\n'),
    );

    expect(parsed.get('Widget')).toEqual(['id', 'label', 'mood', 'ownerId']);
  });

  it('reads both real sides, so the comparisons below are not vacuous', () => {
    expect(models.size).toBeGreaterThan(10);
    expect(models.get('UserPermissionOverride')).toContain('grantedAt');
    expect(documented.get('Session')?.has('refreshTokenHash')).toBe(true);
  });

  it('registers every implemented model in an entity table', () => {
    const unregistered = [...models.keys()].filter((model) => !documented.has(model)).sort();

    expect(
      unregistered,
      'a model exists and the source of truth for names has no row for it — the next author names it whatever they like',
    ).toEqual([]);
  });

  it('names every implemented column in the row of its model', () => {
    const unnamed: string[] = [];

    for (const [model, columns] of models) {
      const named = documented.get(model);

      if (named === undefined) continue;

      for (const column of columns) {
        if (!CONVENTION_COLUMNS.has(column) && !named.has(column))
          unnamed.push(`${model}.${column}`);
      }
    }

    expect(
      unnamed.sort(),
      'the schema persists columns the source of truth for names never mentions',
    ).toEqual([]);
  });
});
