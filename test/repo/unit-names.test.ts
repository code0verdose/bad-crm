import { describe, expect, it } from 'vitest';

import { CLIENT_SRC, clientDirectories } from '../architecture/client-tree.util.js';
import { readRepoFile } from './repo-fixture.util.js';

/**
 * The vocabulary gate: every name the tree already carries has a row in the glossary.
 *
 * Two namespaces, both derived from the tree rather than from a list somebody maintains — a client
 * unit directory and a Prisma model. `docs/product/glossary.md` rule 1 says a name in code is a
 * name in the glossary, and rule 3 says an entity does not reach the schema before its row; until
 * now both were checked by a reviewer noticing, and both were already broken when this file was
 * written (`MfaRecoveryCode` and `RolePermission` shipped without a row).
 *
 * **Direction is deliberately one-way.** Code must be declared; the glossary may declare what has
 * not been built — it names `units/task` and `Prisma: Invoice` for epics that have not run, and a
 * gate demanding the reverse would be red on every one of them and would be deleted within a week.
 *
 * **Where the naive version of this test fails, and why the parsing below is what it is.** A
 * `grep -o 'units/[a-z-]*' docs/product/glossary.md` returns about thirty-five names, four of them
 * — `units/tasks`, `units/files`, `units/dashboards`, `units/session` — present in the document as
 * *forbidden* examples in its prose. A gate built on that grep legalises exactly the names it was
 * written to ban, and stays green while doing it. So the glossary is read as a table: the
 * «Unit / Entity» column of a data row, and nothing else. The definition column is excluded for
 * the same reason as the prose — it is where the row for the client session explains that
 * `units/session` no longer exists.
 *
 * **Boundary, stated so nobody mistakes this for more than it is.** This gate checks *names of
 * directories and models*, not ubiquitous language. The `mfa` / `totp` / `2fa` split lives inside
 * names — a permission key, a URL segment, a model prefix — and is a morpheme, not a directory or a
 * model name. Nothing here will ever see it; the glossary row that reconciles the three spellings
 * is the only thing that does.
 */

/** The `units/*` directories that exist right now, by listing — an empty one counts too. */
const clientUnits = (): string[] => {
  const prefix = `${CLIENT_SRC}/units/`;

  return clientDirectories()
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map((path) => path.slice(prefix.length))
    .sort();
};

/** Every `model X {` of the Prisma schema — the models the server actually persists. */
const prismaModels = (): string[] =>
  [...readRepoFile('packages/server/prisma/schema.prisma').matchAll(/^model\s+(\w+)\s*\{/gm)]
    .map(([, name]) => name as string)
    .sort();

/**
 * The «Unit / Entity» cell of every data row of every table in the glossary.
 *
 * A row of that document has four columns; the header and the `|---|` divider are table syntax, and
 * a line that is not a table row is prose. This is the whole defence against the grep above.
 */
const unitEntityCells = (): string[] =>
  readRepoFile('docs/product/glossary.md')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => line.trim().split('|').slice(1, -1))
    .filter((cells) => cells.length === 4)
    .map((cells) => (cells[3] ?? '').trim())
    .filter((cell) => cell !== '' && !/^-+$/.test(cell) && cell !== 'Unit / Entity');

/** Unit names the glossary declares: a backticked `units/<name>` inside that column. */
const declaredUnits = (): Set<string> =>
  new Set(
    unitEntityCells().flatMap((cell) =>
      [...cell.matchAll(/`units\/([a-z][a-z0-9-]*)`/g)].map(([, name]) => name as string),
    ),
  );

/**
 * Model names the glossary declares: a backticked `PascalCase` token in that column, with any
 * field suffix dropped — a row may point at `Session.refreshTokenHash` rather than at the model.
 */
const declaredModels = (): Set<string> =>
  new Set(
    unitEntityCells().flatMap((cell) =>
      [...cell.matchAll(/`([A-Z][A-Za-z0-9]*)(?:\.[A-Za-z0-9]+)*`/g)].map(
        ([, name]) => name as string,
      ),
    ),
  );

describe('the glossary is read as a table, not as text', () => {
  /**
   * The positive control on the parser: the names it must *not* see are in the file, in prose, and
   * a reader that stopped being a table reader would start returning them.
   */
  it('does not read the forbidden plural examples the prose spells out', () => {
    const glossary = readRepoFile('docs/product/glossary.md');
    const units = declaredUnits();

    for (const forbidden of ['tasks', 'files', 'dashboards', 'session']) {
      expect(glossary, `the prose no longer names units/${forbidden}`).toContain(
        `units/${forbidden}`,
      );
      expect(units, `units/${forbidden} is prose, not a declaration`).not.toContain(forbidden);
    }
  });

  it('reads the canonical singular names the same rows declare', () => {
    expect(declaredUnits()).toContain('task');
    expect(declaredUnits()).toContain('file');
    expect(declaredUnits()).toContain('dashboard');
  });

  it('reads a model named through one of its fields', () => {
    expect(declaredModels()).toContain('Session');
  });
});

describe('every name in the tree has a row in the glossary', () => {
  it.each(clientUnits())('units/%s is declared', (unit) => {
    expect(
      declaredUnits(),
      `packages/client/src/units/${unit} has no row in docs/product/glossary.md — add the term, ` +
        'or rename the directory to the term that is already there',
    ).toContain(unit);
  });

  it.each(prismaModels())('Prisma model %s is declared', (model) => {
    expect(
      declaredModels(),
      `${model} is in prisma/schema.prisma and not in docs/product/glossary.md — rule 3 of the ` +
        'glossary puts the row before the table',
    ).toContain(model);
  });
});
