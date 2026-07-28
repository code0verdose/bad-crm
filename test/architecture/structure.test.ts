import { describe, expect, it } from 'vitest';

import { listRepoFiles, repoEntryNames } from '../repo/repo-fixture.util.js';
import {
  CLIENT_SRC,
  clientDirectories,
  clientSources,
  LAYERS,
  SERVICE_SEGMENTS,
  UNIT_SEGMENTS,
} from './client-tree.util.js';

/**
 * The shape of the tree itself, as opposed to what its files import.
 *
 * The rule being enforced is that a directory is a claim: `service/stores` says a store exists,
 * `units/session/api` says the unit talks to the network. Created "for later", the claim is false
 * and the next reader plans around it — which is why `rules/frontend-fsd.mdc` rule 9 forbids empty
 * segments rather than treating them as harmless.
 */
describe('the client tree', () => {
  it('has no empty directory', () => {
    const empty = clientDirectories().filter((directory) => {
      try {
        return repoEntryNames(directory).length === 0;
      } catch {
        return false;
      }
    });

    expect(empty).toEqual([]);
  });

  it('has no directory that contains only a barrel', () => {
    const barrelOnly = clientDirectories().filter((directory) => {
      const entries = repoEntryNames(directory);
      return entries.length === 1 && entries[0] === 'index.ts';
    });

    expect(barrelOnly, `a barrel over nothing: ${barrelOnly.join(', ')}`).toEqual([]);
  });

  it('contains only the five known layers at the top level', () => {
    const top = repoEntryNames(CLIENT_SRC).filter((entry) => !entry.includes('.'));

    expect(top.filter((entry) => !LAYERS.includes(entry as (typeof LAYERS)[number]))).toEqual([]);
  });
});

describe('unit segments', () => {
  const unitDirs = (): string[] =>
    repoEntryNames(`${CLIENT_SRC}/units`).filter((entry) => !entry.includes('.'));

  it('every unit has a barrel', () => {
    const withoutBarrel = unitDirs().filter(
      (unit) => !repoEntryNames(`${CLIENT_SRC}/units/${unit}`).includes('index.ts'),
    );

    expect(withoutBarrel).toEqual([]);
  });

  it('every segment is one of the segments a unit may have', () => {
    const unexpected = unitDirs().flatMap((unit) =>
      repoEntryNames(`${CLIENT_SRC}/units/${unit}`)
        .filter((entry) => !entry.includes('.'))
        .filter((entry) => !UNIT_SEGMENTS.includes(entry as (typeof UNIT_SEGMENTS)[number]))
        .map((entry) => `${unit}/${entry}`),
    );

    expect(unexpected).toEqual([]);
  });

  it('every subdirectory of service is a known kind', () => {
    const unexpected = unitDirs()
      .filter((unit) => repoEntryNames(`${CLIENT_SRC}/units/${unit}`).includes('service'))
      .flatMap((unit) =>
        repoEntryNames(`${CLIENT_SRC}/units/${unit}/service`)
          .filter((entry) => !entry.includes('.'))
          .filter((entry) => !SERVICE_SEGMENTS.includes(entry as (typeof SERVICE_SEGMENTS)[number]))
          .map((entry) => `${unit}/service/${entry}`),
      );

    expect(unexpected).toEqual([]);
  });

  it('every segment directory has a barrel of its own', () => {
    const withoutBarrel = unitDirs().flatMap((unit) =>
      repoEntryNames(`${CLIENT_SRC}/units/${unit}`)
        .filter((entry) => !entry.includes('.'))
        .filter(
          (segment) =>
            !repoEntryNames(`${CLIENT_SRC}/units/${unit}/${segment}`).includes('index.ts'),
        )
        .map((segment) => `${unit}/${segment}`),
    );

    expect(withoutBarrel).toEqual([]);
  });
});

/**
 * The naming rule is enforced per file by `bad-crm/require-role-suffix`; what it cannot see is a
 * whole directory the ESLint globs no longer match. This asserts the same dictionary over whatever
 * the tree actually contains.
 */
describe('file names', () => {
  const FIXED = new Set(['index', 'main', 'page', 'layout', 'providers', 'router', 'vite-env']);
  const ROLE =
    /\.(component|widget|hook|query|mutation|store|api|types|schema|enums|constant|util|errors|config|client|context|provider|guard|test)\.tsx?$/;

  /**
   * The two kinds of file whose name is not ours to choose (`rules/naming-and-structure.mdc` →
   * «Исключения»), matched here exactly as `eslint.config.js` exempts them:
   *
   * - generated artefacts — `route-tree.gen.ts` is rewritten by `@tanstack/router-plugin` on every
   *   build, and a convention it would have to satisfy is a convention the generator would undo;
   * - file-based routes — the file *name* is the URL. `__root.tsx` and `_authenticated.tsx` are the
   *   router's vocabulary for «root» and «pathless layout», and renaming them to satisfy the suffix
   *   dictionary would change the routing table.
   */
  const GENERATED = /\.gen\.tsx?$/;
  const ROUTE_FILE = /^packages\/client\/src\/app\/routes\//;

  it('names every source file kebab-case with a role suffix, or a framework-fixed name', () => {
    const offenders = clientSources()
      .filter((path) => !GENERATED.test(path) && !ROUTE_FILE.test(path))
      .filter((path) => {
        const name = path.split('/').pop() ?? '';
        const stem = name.split('.')[0] ?? '';

        if (/[A-Z_]/.test(stem)) return true;

        return !FIXED.has(stem) && !stem.endsWith('-page') && !ROLE.test(name);
      });

    expect(offenders).toEqual([]);
  });

  /**
   * The exemption above is a door, so it is measured too: it may only be opened by the router's own
   * directory and by generated files, and every route file has to be one the plugin recognises.
   */
  it('exempts only the routes directory and generated files', () => {
    const exempt = clientSources().filter((path) => GENERATED.test(path) || ROUTE_FILE.test(path));

    expect(exempt.length).toBeGreaterThan(0);
    expect(
      exempt.filter(
        (path) =>
          !path.startsWith('packages/client/src/app/routes/') &&
          !path.endsWith('packages/client/src/app/route-tree.gen.ts'),
      ),
    ).toEqual([]);
  });

  it('keeps stylesheets next to the component they belong to', () => {
    const orphans = listRepoFiles(CLIENT_SRC)
      .filter((path) => path.endsWith('.module.css'))
      .filter((path) => {
        const component = path.replace(/\.module\.css$/, '');
        const siblings = repoEntryNames(path.slice(0, path.lastIndexOf('/')));
        return !siblings.some((entry) => entry.startsWith(`${component.split('/').pop() ?? ''}.`));
      });

    expect(orphans).toEqual([]);
  });
});
