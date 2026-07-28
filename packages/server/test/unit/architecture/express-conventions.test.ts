import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { importsOf, readSource, sourceFiles } from './source-tree.util.js';

const packageJson = (): { dependencies?: Record<string, string> } =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
  ) as { dependencies?: Record<string, string> };

/**
 * Express 5 forwards a rejected promise from an `async` handler to the error middleware by itself
 * (ADR-0002, stack.md → «Express 5 и async-ошибки»). The wrapper and the `express-async-errors`
 * package are therefore not merely unnecessary — they are a signal that somebody carried a 4.x
 * habit over, and the next thing that habit brings is `try/catch` in controllers, which swallows
 * domain errors before the single error handler can map them.
 */
describe('Express 5 conventions', () => {
  it('contains no asyncHandler wrapper anywhere in src', () => {
    const offenders = sourceFiles().filter((file) => /asyncHandler/i.test(readSource(file)));

    expect(offenders).toEqual([]);
  });

  it('does not depend on express-async-errors', () => {
    expect(Object.keys(packageJson().dependencies ?? {})).not.toContain('express-async-errors');
  });

  it('has no try/catch in a controller: domain errors fly to the error handler', () => {
    const offenders = sourceFiles()
      .filter((file) => file.includes('/controllers/'))
      .filter((file) => /\btry\s*\{/.test(readSource(file)));

    expect(offenders).toEqual([]);
  });

  it('never reassigns req.query, which is a getter in Express 5', () => {
    const offenders = sourceFiles().filter((file) => /\breq\.query\s*=/.test(readSource(file)));

    expect(offenders).toEqual([]);
  });

  /**
   * Express 5 dropped the anonymous wildcard: `app.get('/files/*', …)` throws at registration
   * instead of matching, so the defect surfaces as a process that will not boot — but only for the
   * route that has it, which is easy to miss in a large router.
   *
   * Scoped to the files that can register one: `presentation/http/**`, plus anything importing
   * `express` — a path is passed to an `app`/`Router`, and a file that receives one still imports
   * the type. Over the whole of `src` the pattern matches any string containing an asterisk, and
   * `polcmd` is literally `'*'` for a `FOR ALL` policy, which `rls-catalog.util.ts` has to name: a
   * check that cannot tell a route path from a catalog letter has stopped being about Express.
   */
  it('uses only named wildcards in route paths', () => {
    const offenders = sourceFiles()
      .filter(
        (file) =>
          file.startsWith('presentation/http/') ||
          importsOf(file).some((specifier) => specifier.startsWith('express')),
      )
      .filter((file) => /['"][^'"]*\*['"]/.test(readSource(file)));

    expect(offenders).toEqual([]);
  });
});
