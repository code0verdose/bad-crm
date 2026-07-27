import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FSD_ALIASES } from '../../packages/client/src/shared/config/fsd-aliases.constant.js';
import clientViteConfig from '../../packages/client/vite.config.js';
import { PACKAGE_DIRS, readJson } from './repo-fixture.util.js';

/**
 * The aliases are declared three times — in `tsconfig.json` for the compiler, in `vite.config.ts`
 * for the bundler and the runner, and once as data in `fsd-aliases.constant.ts` — and the third is
 * the source the other two are derived from or checked against.
 *
 * The failure this prevents is not "an alias is missing". It is an alias that resolves in two of
 * the three: the editor is red while CI is green, or `vite build` succeeds on a path `tsc` cannot
 * see. Both were deferred from STORY-001-02 with the note that there was nothing to compare
 * against yet; `vite.config.ts` is that second declaration.
 */
interface TsConfig {
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

interface ViteAliasEntry {
  find: string | RegExp;
  replacement: string;
}

const clientTsconfig = (): TsConfig =>
  readJson<TsConfig>(join(PACKAGE_DIRS.client, 'tsconfig.json'));

const viteAliases = (): ViteAliasEntry[] => {
  const { alias } = clientViteConfig.resolve ?? {};

  if (!Array.isArray(alias)) {
    throw new Error('vite.config.ts must declare resolve.alias as an array of entries');
  }

  return alias as ViteAliasEntry[];
};

/** `@shared/*` and `@shared` are one alias for a prefix matcher; the table keys keep the tsconfig form. */
const withoutWildcard = (alias: string): string => alias.replace(/\/\*$/, '');

describe('client path aliases', () => {
  it('declares the layers the FSD architecture is made of', () => {
    // Not a copy of the object under test: the layer names come from `rules/frontend-fsd.mdc`, and
    // an alias silently dropped from the table would otherwise pass every comparison below.
    expect(Object.keys(FSD_ALIASES)).toEqual(
      expect.arrayContaining(['@app', '@pages', '@widgets/*', '@units/*', '@shared']),
    );
  });

  it('mirrors every alias into tsconfig, with the same target', () => {
    const paths = clientTsconfig().compilerOptions?.paths ?? {};

    expect(Object.keys(paths).sort()).toEqual(Object.keys(FSD_ALIASES).sort());
    for (const [alias, target] of Object.entries(FSD_ALIASES)) {
      expect(paths[alias], `tsconfig maps ${alias} elsewhere`).toEqual([target]);
    }
  });

  it('anchors the tsconfig paths to the package, so they resolve from any working directory', () => {
    expect(clientTsconfig().compilerOptions?.baseUrl).toBe('.');
  });

  it('mirrors every alias into the Vite resolver, pointing at the same directory', () => {
    const byFind = new Map(viteAliases().map((entry) => [String(entry.find), entry.replacement]));

    for (const [alias, target] of Object.entries(FSD_ALIASES)) {
      const replacement = byFind.get(withoutWildcard(alias));

      expect(replacement, `vite.config.ts does not resolve ${alias}`).toBeDefined();
      expect(String(replacement).replaceAll('\\', '/')).toMatch(
        new RegExp(`packages/client/${withoutWildcard(target).replace('./', '')}$`),
      );
    }
  });

  /**
   * The other direction, and the one that was missing.
   *
   * The loop above walks `FSD_ALIASES` and checks each entry is present in Vite — so an alias added
   * only to `vite.config.ts` passed. Measured: appending `{ find: '@legacy', replacement: … }` left
   * all eight assertions green. That alias resolves in the bundler and in vitest, and not in `tsc`
   * — exactly the "green CI, red editor" split this file exists to prevent.
   */
  it('resolves nothing beyond the declared aliases', () => {
    const declared = new Set(Object.keys(FSD_ALIASES).map(withoutWildcard));
    const extra = viteAliases()
      .map((entry) => String(entry.find))
      .filter((find) => !declared.has(find));

    expect(extra).toEqual([]);
  });

  it('resolves the longest alias first, so a shorter one cannot shadow it', () => {
    // `@/` is a prefix of nothing, but `@app` is a prefix of `@app/routes`: with Vite's array form
    // the first match wins, and an alphabetical order would rewrite `@app/...` with the `@/*` entry.
    const lengths = viteAliases().map((entry) => String(entry.find).length);

    expect(lengths).toEqual([...lengths].sort((left, right) => right - left));
  });

  it('serves the SPA on the port the quickstart and the preflight check name', () => {
    expect(clientViteConfig.server?.port).toBe(5173);
    // A dev server that quietly moves to 5174 answers on a port nothing else in the project knows.
    expect(clientViteConfig.server?.strictPort).toBe(true);
  });

  it('proxies the API prefix instead of teaching the browser a second origin', () => {
    // Same origin in development means the session cookie is first-party there too — no CORS
    // exception and no `SameSite=None` anywhere (rules/security.mdc).
    expect(JSON.stringify(clientViteConfig.server?.proxy ?? {})).toContain('/api');
  });

  it('emits sourcemaps, without which a client error report is a stack of minified names', () => {
    expect(clientViteConfig.build?.sourcemap).toBe(true);
  });
});
