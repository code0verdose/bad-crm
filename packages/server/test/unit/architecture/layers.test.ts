import { describe, expect, it } from 'vitest';

// The specifiers a real `@prisma/client` import uses today, read from the same array
// `PRISMA_OUTSIDE_PERSISTENCE.group` in `eslint.config.js` is built from — see the export's docstring
// there. Importing it here, rather than writing `'@prisma/client'` a second time, is what
// ADR-0027 wave 3 asks for: when the Prisma client relocates, this suite either starts matching the
// new specifier automatically or breaks loudly, instead of continuing to search shipped code for a
// string nothing imports any more (`rules/testing.mdc`, «Тест, который не видели красным»).
import { PRISMA_MODULE_SPECIFIERS } from '../../../../../eslint.config.js';

import { importsOf, readSource, sourceFiles } from './source-tree.util.js';

const filesIn = (layer: string): string[] =>
  sourceFiles().filter((file) => file.startsWith(`${layer}/`));

const importsIn = (layer: string): { file: string; specifier: string }[] =>
  filesIn(layer).flatMap((file) => importsOf(file).map((specifier) => ({ file, specifier })));

/**
 * Reading the clock, in the two shapes TypeScript offers: `Date.now()` and `new Date(...)`.
 *
 * `new Date` is banned with its argument as well, not only the argless form: `new Date(value)` in a
 * policy means the policy is parsing time itself, and the value it parses came from somewhere the
 * domain does not control. The sanctioned way in is `ClockPort`, whose `now()` this pattern does not
 * match because it is a method call on an injected object.
 */
const CLOCK = /\bDate\.now\s*\(|\bnew\s+Date\s*\(/;

/** Source with block comments, line comments and string literals removed. */
const stripComments = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '')
    .replaceAll(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replaceAll(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replaceAll(/`(?:[^`\\]|\\.)*`/g, '``');

const offenders = (layer: string, forbidden: (specifier: string) => boolean): string[] =>
  importsIn(layer)
    .filter(({ specifier }) => forbidden(specifier))
    .map(({ file, specifier }) => `${file} → ${specifier}`);

const startsWithAny =
  (...prefixes: string[]) =>
  (specifier: string): boolean =>
    prefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));

/**
 * `PRISMA_MODULE_SPECIFIERS` carries ESLint's own glob shape, `['@prisma/client',
 * '@prisma/client/*']`: the trailing `/*` is `no-restricted-imports` syntax for "or any submodule of
 * this", which `startsWithAny` already expresses by matching the bare prefix plus a trailing `/`.
 * Feeding the glob entry to `startsWithAny` unmodified would look for the literal substring `/*` in
 * an import specifier and never match anything — so it is stripped here, once, rather than assumed
 * correct at every call site.
 */
const PRISMA_PREFIXES = [...new Set(PRISMA_MODULE_SPECIFIERS.map((s) => s.replace(/\/\*$/, '')))];

/**
 * The dependency rule of `rules/hexagonal-backend.mdc`, checked against the tree rather than
 * against a reviewer's memory. ESLint enforces the same bans while it runs on a file; this suite
 * proves the property holds for the layer as a whole, including files a future flat-config glob
 * stops matching.
 */
describe('dependencies point inwards', () => {
  it('has sources in every layer, so the assertions below are not vacuous', () => {
    for (const layer of ['domain', 'application', 'infrastructure', 'presentation']) {
      expect(filesIn(layer).length, layer).toBeGreaterThan(0);
    }
  });

  /**
   * Positive control for the detector itself. Every assertion below has the shape
   * `expect(offenders).toEqual([])`, which is also what a broken `importsOf` returns: if the import
   * regexp stops matching — after a formatting change, after a move to a different import syntax —
   * the whole block goes quiet and stays green. This asserts that it still extracts something known.
   */
  it('extracts imports, so an empty offender list means what it says', () => {
    expect(importsOf('main.ts')).toContain('@/infrastructure/bootstrap/api-process.factory.js');
  });

  it('keeps domain free of the outer layers', () => {
    expect(
      offenders('domain', startsWithAny('@/application', '@/infrastructure', '@/presentation')),
    ).toEqual([]);
  });

  /**
   * Positive control for `PRISMA_PREFIXES` itself, in the same spirit as the "extracts imports" case
   * above: an empty (or emptied-by-mutation) array would make the two `startsWithAny(...PRISMA_PREFIXES)`
   * checks below vacuously true, and both offender lists would read `[]` for the wrong reason.
   */
  it('reads a non-empty Prisma ban out of eslint.config.js, so the checks below are not vacuous', () => {
    expect(PRISMA_MODULE_SPECIFIERS.length).toBeGreaterThan(0);
    expect(PRISMA_PREFIXES.length).toBeGreaterThan(0);
  });

  /**
   * Ties the imported ban back to the one file the ban exists to allow: `infrastructure/persistence`
   * is where `@prisma/client` is actually imported (`prisma.client.ts`). If a future migration moves
   * that import to a specifier `PRISMA_PREFIXES` no longer names, this fails here — loudly, on the
   * side of "the detector stopped matching real code" — instead of the domain/application checks
   * below just quietly finding nothing to flag.
   */
  it('matches the specifier a real Prisma import in infrastructure/persistence actually uses', () => {
    const realImports = importsOf('infrastructure/persistence/prisma/prisma.client.ts');
    expect(realImports.some(startsWithAny(...PRISMA_PREFIXES))).toBe(true);
  });

  it('keeps domain free of I/O: no Node built-ins, HTTP, Redis, Prisma or a logger', () => {
    expect(
      offenders(
        'domain',
        (specifier) =>
          specifier.startsWith('node:') ||
          startsWithAny(
            'express',
            'ioredis',
            ...PRISMA_PREFIXES,
            'pino',
            'socket.io',
            'bullmq',
          )(specifier),
      ),
    ).toEqual([]);
  });

  /**
   * The other half of «pure»: the domain does not read the clock either.
   *
   * `rules/hexagonal-backend.mdc` puts `Date.now()` beside I/O in the same sentence, and policies
   * say so in their own docstrings — `domain/identity/access/mfa-policy.policy.ts` promises «no
   * I/O, no `Date.now()`». Until 2026-08-28 nothing checked the second half: no ESLint rule names
   * `Date`, and the import-based checks above cannot see it, because reading the clock takes no
   * import at all. A rule that lives only in prose is kept until the first person in a hurry.
   *
   * Why it matters more than tidiness: a policy that reads the clock is a policy whose verdict
   * depends on when it ran, which is exactly what makes an authorisation decision untestable and
   * unauditable. Time enters through `ClockPort`, so the decision is a function of its inputs and a
   * test can put the boundary case anywhere it likes.
   *
   * Comments and strings are stripped first — the docstrings that *describe* the ban say the words.
   */
  it('keeps domain free of the clock: time arrives through ClockPort, never from `Date`', () => {
    const readsClock = filesIn('domain')
      .filter((file) => CLOCK.test(stripComments(readSource(file))))
      .sort();

    expect(
      readsClock,
      'take the instant as an argument (`ClockPort`) — a decision that depends on when it ran cannot be tested at its boundary',
    ).toEqual([]);
  });

  it('CONTROL: the clock detector fires on the shapes it is meant to catch', () => {
    expect(CLOCK.test('const now = Date.now();')).toBe(true);
    expect(CLOCK.test('const now = new Date();')).toBe(true);
    expect(CLOCK.test('const at = new Date(input.expiresAt);')).toBe(true);
    // Not the ban: a type annotation names no instant, and `clock.now()` is the sanctioned way in.
    expect(CLOCK.test('readonly expiresAt: Date;')).toBe(false);
    expect(CLOCK.test('const now = this.clock.now();')).toBe(false);
  });

  it('keeps application away from adapters — concrete implementations are wired in main.ts', () => {
    expect(offenders('application', startsWithAny('@/infrastructure', '@/presentation'))).toEqual(
      [],
    );
  });

  it('keeps application unaware of the transport it was called over', () => {
    expect(offenders('application', startsWithAny('express', ...PRISMA_PREFIXES, 'pino'))).toEqual(
      [],
    );
  });

  it('keeps presentation away from infrastructure: a controller imports ports, not adapters', () => {
    expect(offenders('presentation', startsWithAny('@/infrastructure'))).toEqual([]);
  });

  /**
   * With one named exception: `infrastructure/bootstrap` **is** the composition root. It is the
   * place that constructs adapters and hands them to the HTTP application, so it necessarily knows
   * both sides — the same reason `rules/hexagonal-backend.mdc` already exempts it from the ban on
   * reading `process.env`. Everything else in `infrastructure` is a driven adapter and has no
   * business knowing that an HTTP layer exists.
   */
  it('keeps infrastructure from reaching back into presentation, outside the composition root', () => {
    const offending = importsIn('infrastructure')
      .filter(({ file }) => !file.startsWith('infrastructure/bootstrap/'))
      .filter(({ specifier }) => startsWithAny('@/presentation')(specifier))
      .map(({ file, specifier }) => `${file} → ${specifier}`);

    expect(offending).toEqual([]);
  });

  it('confines the composition root to bootstrap: no other file builds the application', () => {
    const builders = sourceFiles().filter(
      (file) =>
        file !== 'main.ts' &&
        !file.startsWith('infrastructure/bootstrap/') &&
        importsOf(file).some((specifier) => specifier.includes('http-server.factory')),
    );

    expect(builders).toEqual([]);
  });

  it('imports through the @/ alias, never through a parent-relative path', () => {
    const relative = sourceFiles().flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith('../'))
        .map((specifier) => `${file} → ${specifier}`),
    );

    expect(relative).toEqual([]);
  });
});

/**
 * A port declared next to its implementation is a port in name only: the use-case then depends on
 * the adapter's file, and swapping the adapter means editing `application`. The interface belongs to
 * the layer that needs it.
 */
describe('ports are declared by the layer that consumes them', () => {
  it('places every *.port.ts under application/<context>/ports/', () => {
    const misplaced = sourceFiles().filter(
      (file) => file.endsWith('.port.ts') && !/^application\/[^/]+\/ports\//.test(file),
    );

    expect(misplaced).toEqual([]);
  });

  it('places every *.adapter.ts under infrastructure/', () => {
    const misplaced = sourceFiles().filter(
      (file) => file.endsWith('.adapter.ts') && !file.startsWith('infrastructure/'),
    );

    expect(misplaced).toEqual([]);
  });

  it('has at least one port and one adapter, so the health example really crosses the boundary', () => {
    expect(sourceFiles().filter((file) => file.endsWith('.port.ts')).length).toBeGreaterThan(0);
    expect(sourceFiles().filter((file) => file.endsWith('.adapter.ts')).length).toBeGreaterThan(0);
  });
});

describe('controllers stay thin', () => {
  it('never imports a repository directly', () => {
    const offending = sourceFiles()
      .filter((file) => file.includes('/controllers/'))
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => specifier.includes('.repository'))
          .map((specifier) => `${file} → ${specifier}`),
      );

    expect(offending).toEqual([]);
  });
});

/**
 * The skeleton is the template every later context is copied from, so the template itself has to be
 * complete: a context with use-cases but no `ports/` directory teaches the next author that ports
 * are optional.
 */
describe('the context template is complete', () => {
  it.each(['domain', 'application', 'infrastructure', 'presentation'])(
    'ships a real %s layer, not an empty folder',
    (layer) => {
      expect(filesIn(layer).length).toBeGreaterThan(0);
    },
  );

  it('gives the platform context both a ports/ and a use-cases/ directory', () => {
    expect(sourceFiles().some((file) => file.startsWith('application/platform/ports/'))).toBe(true);
    expect(sourceFiles().some((file) => file.startsWith('application/platform/use-cases/'))).toBe(
      true,
    );
  });
});
