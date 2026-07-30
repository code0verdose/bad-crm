/**
 * @vitest-environment node
 *
 * The two things `shared/ui` must not become, asserted over the tree rather than trusted to review.
 *
 * A presentational kit earns its keep by being reusable, and it stops being reusable the moment one
 * component knows what a task is or where sessions come from. Both failures are invisible from
 * inside: the import compiles, the tests of that component pass, and the cost only appears the day
 * somebody wants the component in a context the domain does not exist in — or the day `shared/ui`
 * cannot be rendered in a workshop because it starts a request.
 *
 * ESLint's layer rule already forbids the upward direction per file. This is the same statement over
 * the directory that actually ships, because a rule confined to a glob stops applying the moment a
 * file lands outside it (`rules/frontend-fsd.mdc`, EPIC-007 acceptance).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SHARED_UI = fileURLToPath(new URL('../../src/shared/ui', import.meta.url));

const sourceFiles = (directory: string = SHARED_UI): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];

    return [path];
  });

const importsOf = (source: string): string[] =>
  [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1] as string);

const modules = (): { file: string; specifier: string }[] =>
  sourceFiles().flatMap((file) =>
    importsOf(readFileSync(file, 'utf8')).map((specifier) => ({
      file: file.slice(SHARED_UI.length + 1),
      specifier,
    })),
  );

/** Everything above `shared` in the layer order, plus the alias that reaches a domain slice. */
const UPWARD = /^@(app|pages|widgets|units)\b/;

/**
 * What "does not go to the network" means as a list of specifiers.
 *
 * `@shared/api` is on it even though it is the same layer: the kit is rendered by a workshop and by
 * tests with no server, and a component that reaches for the typed client cannot be shown in either.
 * The data layer belongs to the unit that owns the data; `shared/ui` takes it as props.
 */
const NETWORK = ['@shared/api', '@tanstack/react-query', 'openapi-fetch', 'axios'];

describe('shared/ui', () => {
  it('CONTROL: the walk finds the components it is asserting about', () => {
    // Without this, an empty directory — or a rename that moves the kit — would make every assertion
    // below vacuously true and the guard would be gone with no test turning red.
    expect(sourceFiles().length).toBeGreaterThan(5);
    expect(modules().length).toBeGreaterThan(5);
  });

  it('knows about no domain and no layer above it', () => {
    const upward = modules().filter(({ specifier }) => UPWARD.test(specifier));

    expect(
      upward,
      'a shared component importing a unit, a page or the app layer is no longer shared — it is that ' +
        'domain’s component living in the wrong directory',
    ).toEqual([]);
  });

  it('reaches no network of its own', () => {
    const networked = modules().filter(
      ({ specifier }) =>
        NETWORK.includes(specifier) ||
        specifier.startsWith('@shared/api/') ||
        specifier === 'fetch',
    );

    expect(
      networked,
      'a presentational component that fetches cannot be rendered without a server, and decides for ' +
        'every caller how its data is loaded',
    ).toEqual([]);
  });

  it('calls no fetch directly either', () => {
    const calling = sourceFiles().filter((file) =>
      /\b(?:globalThis\.|window\.|self\.)?fetch\s*\(/.test(readFileSync(file, 'utf8')),
    );

    expect(calling.map((file) => file.slice(SHARED_UI.length + 1))).toEqual([]);
  });
});
