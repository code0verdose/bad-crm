import { describe, expect, it } from 'vitest';

import { readRepoFile, repoEntryNames } from '../repo/repo-fixture.util.js';
import {
  applicationSources,
  CLIENT_SRC,
  importsOf,
  layerOf,
  unitOf,
  unitOfSpecifier,
} from './client-tree.util.js';

/** Capitalises a kebab unit name the way the namespace convention spells it: `session` → `Session`. */
const pascal = (name: string): string =>
  name
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');

const directoriesIn = (path: string): string[] =>
  repoEntryNames(path).filter((entry) => !entry.includes('.'));

const units = (): string[] => directoriesIn(`${CLIENT_SRC}/units`);

/**
 * A barrel is the only public surface of a unit, and a namespace is how its segments are read at a
 * call site (`SessionService.useSessionStatus()`).
 *
 * The check that matters is completeness: a segment added without a line in the barrel is invisible
 * to consumers, so the next person imports it deeply and the boundary is gone one file at a time.
 */
describe('unit barrels', () => {
  it('there is a unit to check, so this file cannot pass over an empty tree', () => {
    expect(units().length).toBeGreaterThan(0);
  });

  it.each(units())('%s exposes every segment it has, as a namespace', (unit) => {
    const barrel = readRepoFile(`${CLIENT_SRC}/units/${unit}/index.ts`);
    const segments = directoriesIn(`${CLIENT_SRC}/units/${unit}`);

    const missing = segments.filter((segment) => {
      const namespace = `${pascal(unit)}${pascal(segment)}`;
      return !new RegExp(`export (type )?\\* as ${namespace} from`).test(barrel);
    });

    expect(missing, `${unit}/index.ts does not re-export: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(units())('%s re-exports nothing that does not exist', (unit) => {
    const barrel = readRepoFile(`${CLIENT_SRC}/units/${unit}/index.ts`);
    const segments = new Set(directoriesIn(`${CLIENT_SRC}/units/${unit}`));
    const exported = [...barrel.matchAll(/from '\.\/([^/']+)/g)].map(([, segment]) => segment);

    expect(exported.filter((segment) => !segments.has(segment as string))).toEqual([]);
  });
});

describe('the shared layer barrel', () => {
  it('exposes every segment it has, as a namespace', () => {
    const barrel = readRepoFile(`${CLIENT_SRC}/shared/index.ts`);

    const missing = directoriesIn(`${CLIENT_SRC}/shared`).filter(
      (segment) => !new RegExp(`export \\* as Shared${pascal(segment)} from`).test(barrel),
    );

    expect(missing, `shared/index.ts does not re-export: ${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * A specifier that reaches *inside* a unit (`@units/session/model`) rather than at its barrel
 * (`@units/session`).
 *
 * Named, because the assertion built on it compares against an empty list: a predicate that matches
 * nothing produces exactly the same empty list as a tree with no violations. Measured: dropping the
 * `s` from `@units` left the check below green while the barrier it guards was unguarded. Only the
 * CONTROL cases, which feed this function a specifier of each shape directly, tell the two apart.
 */
const isDeepUnitImport = (specifier: string): boolean => /^@units\/[^/]+\/.+/.test(specifier);

describe('consumers see units through the barrel only', () => {
  it('no page, widget, app or shared file imports a path inside a unit', () => {
    const deep = applicationSources()
      .filter((path) => layerOf(path) !== 'units')
      .flatMap((path) =>
        importsOf(path)
          .filter(isDeepUnitImport)
          .map((specifier) => `${path} → ${specifier}`),
      );

    expect(deep).toEqual([]);
  });

  /** CONTROL: the detector recognises a path inside a unit — it dies with the regex above. */
  it.each(['@units/session/model', '@units/iam/service/hooks/use-can.hook.js'])(
    'CONTROL: %s counts as reaching inside a unit',
    (specifier) => {
      expect(isDeepUnitImport(specifier)).toBe(true);
    },
  );

  /** CONTROL: and does not fire on the legal shapes, so the check above is not a blanket ban. */
  it.each(['@units/session', '@shared/ui', './model/index.js', 'react'])(
    'CONTROL: %s does not count as reaching inside a unit',
    (specifier) => {
      expect(isDeepUnitImport(specifier)).toBe(false);
    },
  );

  /** CONTROL: those files do import units, so the filter above runs over candidates, not nothing. */
  it('CONTROL: pages, widgets, app and shared do import units, through the barrel', () => {
    const barrelImports = applicationSources()
      .filter((path) => layerOf(path) !== 'units')
      .flatMap((path) =>
        importsOf(path).filter((specifier) => unitOfSpecifier(specifier) !== undefined),
      );

    expect(barrelImports.length).toBeGreaterThan(0);
  });

  /**
   * The mirror image, and the one a path-pattern ban gets wrong: inside its own unit a file is
   * *supposed* to import its neighbours by their segment path, because the barrel would be a cycle.
   */
  it('a unit still reaches its own segments, which is how a unit is written', () => {
    const ownSegmentImports = applicationSources()
      .filter((path) => unitOf(path) !== undefined)
      .flatMap((path) =>
        importsOf(path).filter((specifier) => unitOfSpecifier(specifier) === unitOf(path)),
      );

    expect(ownSegmentImports.length).toBeGreaterThan(0);
  });
});
