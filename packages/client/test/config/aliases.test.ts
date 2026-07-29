import { describe, expect, it } from 'vitest';

import { App } from '@app';
import { DashboardPage } from '@pages';
import { FSD_ALIASES } from '@shared/config';
import { AuthService } from '@units/auth';
import { AppStatus } from '@widgets/app-status';

/**
 * The runtime half of the alias contract.
 *
 * `test/repo/client-aliases.test.ts` compares the three configurations as data — it would still
 * pass if every alias pointed at a directory that does not exist. This file imports through each
 * alias instead, so the assertion is that the runner resolves them, and `pnpm typecheck` and
 * `vite build` make the same claim for the compiler and the bundler by refusing to finish.
 *
 * Both bare aliases (`@app`, `@pages`, `@shared`) and prefix aliases (`@units/*`, `@widgets/*`)
 * are exercised: they are separate entries in the table and a prefix match can shadow a bare one.
 */
describe('FSD aliases resolve at runtime', () => {
  it.each([
    ['@app', App],
    ['@pages', DashboardPage],
    ['@widgets/*', AppStatus],
    ['@units/*', AuthService.useBootstrapSession],
    ['@shared/*', FSD_ALIASES],
  ])('%s resolves to a real module export', (_alias, imported) => {
    expect(imported).toBeDefined();
  });

  /**
   * The list is closed on purpose, and `@/*` is deliberately absent.
   *
   * A catch-all next to layer aliases is a second spelling for every path the layer aliases
   * restrict: `@/units/auth/service/hooks/...` reached into another unit's internals with ESLint
   * silent and all twenty architecture tests green, because every guard matches the literal
   * `@units/`. Measured, not supposed. Re-adding it here re-opens all of them at once.
   */
  it('declares every alias the layers need, and nothing beyond them', () => {
    expect(Object.keys(FSD_ALIASES).sort()).toEqual([
      '@app',
      '@app/*',
      '@pages',
      '@pages/*',
      '@shared',
      '@shared/*',
      '@units/*',
      '@widgets/*',
    ]);
  });
});
