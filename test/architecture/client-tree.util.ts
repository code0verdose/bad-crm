import { listRepoFiles, readRepoFile, repoEntryNames } from '../repo/repo-fixture.util.js';

/** Root of the client sources, the tree every assertion in `test/architecture` is made about. */
export const CLIENT_SRC = 'packages/client/src';

/** The five FSD layers, in dependency order: each may import the ones after it, never before. */
export const LAYERS = ['app', 'pages', 'widgets', 'units', 'shared'] as const;

export type Layer = (typeof LAYERS)[number];

/** Segments a unit may have (`rules/frontend-fsd.mdc`, rule 9). A new one is added here first. */
export const UNIT_SEGMENTS = ['api', 'service', 'model', 'lib', 'types', 'ui'] as const;

/** Subdirectories of `service`, in the same sense: the closed list, not "whatever exists". */
/**
 * `guards` is the fifth because a route guard is neither a hook nor a query: it runs in
 * `beforeLoad`, outside React, and it reads through the query client the router hands it. A guard
 * that needs no data lives in `lib` (`units/auth/lib/guards`); one that has to ask the server
 * belongs here, where a unit is allowed to reach its own `api`.
 */
export const SERVICE_SEGMENTS = ['queries', 'mutations', 'hooks', 'stores', 'guards'] as const;

/** `from '…'` and `import '…'`, both static and dynamic — every form the client uses. */
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

const isSource = (path: string): boolean => /\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts');

/** Every TypeScript source of the client, tests included, as repository-relative paths. */
export const clientSources = (): string[] => listRepoFiles(CLIENT_SRC).filter(isSource);

/** Every source that is not a test — the application tree the architecture rules are about. */
export const applicationSources = (): string[] =>
  clientSources().filter((path) => !/\.test\.tsx?$/.test(path));

/** Import specifiers of one file, in source order. */
export const importsOf = (path: string): string[] =>
  [...readRepoFile(path).matchAll(IMPORT_SPECIFIER)]
    .map(([, specifier]) => specifier)
    .filter((specifier): specifier is string => specifier !== undefined);

/** The FSD layer a client file belongs to, or `undefined` for anything above the layers. */
export const layerOf = (path: string): Layer | undefined =>
  LAYERS.find((layer) => path.startsWith(`${CLIENT_SRC}/${layer}/`));

/** The unit a file belongs to, or `undefined` outside `units/`. */
export const unitOf = (path: string): string | undefined =>
  new RegExp(`^${CLIENT_SRC}/units/([^/]+)/`).exec(path)?.[1];

/** The unit segment a file belongs to (`ui`, `service`, …), or `undefined` outside a unit. */
export const segmentOf = (path: string): string | undefined =>
  new RegExp(`^${CLIENT_SRC}/units/[^/]+/([^/]+)/`).exec(path)?.[1];

/** Layer an alias specifier points at (`@units/session/model` → `units`), if it points at one. */
export const layerOfSpecifier = (specifier: string): Layer | undefined =>
  LAYERS.find((layer) => specifier === `@${layer}` || specifier.startsWith(`@${layer}/`));

/** Unit an alias specifier points at, for `@units/<unit>` and any path inside it. */
export const unitOfSpecifier = (specifier: string): string | undefined =>
  /^@units\/([^/]+)/.exec(specifier)?.[1];

/**
 * Every directory of the client tree, walked by listing rather than derived from the files found.
 *
 * The distinction is the whole point: an empty directory contains no file, so a walk built from
 * file paths cannot see it — and "no empty segments" is exactly the rule that has to see it.
 */
export const clientDirectories = (relativeDir: string = CLIENT_SRC): string[] =>
  repoEntryNames(relativeDir).flatMap((entry) => {
    const path = `${relativeDir}/${entry}`;

    try {
      // A listing that succeeds is a directory; one that throws ENOTDIR is a file.
      repoEntryNames(path);
    } catch {
      return [];
    }

    return [path, ...clientDirectories(path)];
  });
