import { join } from 'node:path';

import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';

import { readJson, readRepoFile, repoRoot } from '../repo/repo-fixture.util.js';

/**
 * Stylelint is the machine half of `rules/design-system.mdc` §3, and a linter is only worth its
 * install size while it still fires. Installing the package and committing a config proves nothing:
 * a single mistyped regular expression, a rule quietly set to `null`, an `overrides` entry widened
 * from a file to a directory — each leaves the command green on the very CSS it exists to reject,
 * and none of them is visible in review.
 *
 * So every claim the config makes is asserted here against CSS that violates it. The snippets are
 * linted through the real `stylelint.config.js`, at realistic paths, because the `overrides` that
 * exempt `tokens.css` are path-dependent and a fixture in an invented directory would exercise a
 * different configuration from the shipped one.
 */

const CONFIG_FILE = join(repoRoot, 'stylelint.config.js');

/** A stylesheet path that has no exemption: an ordinary CSS module inside a unit. */
const MODULE = join(repoRoot, 'packages/client/src/units/task/ui/task-card.module.css');

interface TurboTask {
  dependsOn?: string[];
  inputs?: string[];
  outputs?: string[];
}

const turbo = (): { tasks: Record<string, TurboTask> } =>
  readJson<{ tasks: Record<string, TurboTask> }>('turbo.json');

const rootScripts = (): Record<string, string> =>
  readJson<{ scripts?: Record<string, string> }>('package.json').scripts ?? {};

/** The rule ids stylelint reports for a snippet, sorted and de-duplicated. */
const rulesFiredFor = async (code: string, codeFilename = MODULE): Promise<string[]> => {
  const { results } = await stylelint.lint({ code, codeFilename, configFile: CONFIG_FILE });
  const [result] = results;

  expect(result, 'stylelint produced no result for the snippet').toBeDefined();
  expect(result?.parseErrors ?? [], 'the snippet does not parse as CSS').toEqual([]);

  return [...new Set((result?.warnings ?? []).map((warning) => warning.rule))].sort();
};

describe('literal values are rejected in favour of tokens', () => {
  it.each([
    ['a hex colour', '.card { color: #1971c2; }', 'color-no-hex'],
    ['a named colour', '.card { color: white; }', 'color-named'],
    [
      'a functional colour',
      '.card { background: rgb(244 244 245); }',
      'declaration-property-value-disallowed-list',
    ],
    [
      'a colour built with color-mix',
      '.card { background: color-mix(in srgb, var(--bc-surface), var(--bc-border)); }',
      'declaration-property-value-disallowed-list',
    ],
    [
      'a magic pixel value',
      '.card { padding: 13px; }',
      'declaration-property-value-disallowed-list',
    ],
    [
      'a magic pixel value hidden behind a sign',
      '.card { margin-block-start: -8px; }',
      'declaration-property-value-disallowed-list',
    ],
    [
      'a magic pixel value inside a Mantine rem() helper',
      '.card { font-size: rem(14px); }',
      'declaration-property-value-disallowed-list',
    ],
    [
      'a custom property outside the token namespace',
      '.card { --card-gap: var(--mantine-spacing-md); }',
      'custom-property-pattern',
    ],
  ])('rejects %s', async (_case, code, rule) => {
    expect(await rulesFiredFor(code)).toContain(rule);
  });

  it.each([
    ['a semantic token', '.card { background: var(--bc-surface-raised); }'],
    ['a palette token', '.card { color: var(--mantine-color-gray-7); }'],
    ['a scheme-aware token', '.card { color: light-dark(var(--bc-text), var(--bc-surface)); }'],
    ['arithmetic over a spacing token', '.card { gap: calc(var(--mantine-spacing-md) / 2); }'],
    // The one pixel that stays legal, and the two idioms that need it: the hairline border every
    // surface in the client draws, and the 1×1 box of the visually-hidden pattern.
    ['a hairline border', '.card { border: 1px solid var(--bc-border); }'],
    ['the visually-hidden box', '.card {\n  block-size: 1px;\n  inline-size: 1px;\n}'],
    ['a zero length', '.card { padding: 0; }'],
  ])('accepts %s', async (_case, code) => {
    expect(await rulesFiredFor(code)).toEqual([]);
  });
});

describe('breakpoints are named, never measured', () => {
  /**
   * `declaration-property-value-disallowed-list` only ever sees declarations, so the magic pixel
   * that matters most — the one in a media query — needs its own rule. Both notations are covered
   * because `stylelint-config-standard` prefers one and Mantine documents the other.
   */
  it.each([
    ['prefix notation', '@media (max-width: 768px) { .card { display: none; } }'],
    ['range notation', '@media (width <= 768px) { .card { display: none; } }'],
    ['an em breakpoint that is still a number', '@media (max-width: 48em) { .card { gap: 0; } }'],
  ])('rejects a hard-coded breakpoint in %s', async (_case, code) => {
    expect(await rulesFiredFor(code)).toContain('media-feature-name-value-allowed-list');
  });

  it.each([
    [
      'the simple-vars breakpoint',
      '@media (max-width: $mantine-breakpoint-sm) { .card { gap: 0; } }',
    ],
    ['the preset mixin', '@mixin smaller-than $mantine-breakpoint-md { .card { gap: 0; } }'],
    [
      'a non-dimensional feature',
      '@media (prefers-reduced-motion: reduce) { .card { transition: none; } }',
    ],
  ])('accepts %s', async (_case, code) => {
    expect(await rulesFiredFor(code)).toEqual([]);
  });
});

describe('logical properties are required', () => {
  it.each([
    ['margin-left', '.card { margin-left: var(--mantine-spacing-sm); }'],
    ['padding-right', '.card { padding-right: var(--mantine-spacing-sm); }'],
    ['left', '.card { left: 0; }'],
    ['border-left', '.card { border-left: 1px solid var(--bc-border); }'],
    ['width', '.card { width: 100%; }'],
    ['max-height', '.card { max-height: 100%; }'],
    // The block-axis borders and every longhand of them, named one by one: the shorthand is what a
    // stylesheet actually writes, but a rule that lists only the shorthand is walked around by
    // `border-bottom-color` without anyone noticing.
    ['border-top', '.card { border-top: 1px solid var(--bc-border); }'],
    ['border-top-width', '.card { border-top-width: 1px; }'],
    ['border-top-style', '.card { border-top-style: solid; }'],
    ['border-top-color', '.card { border-top-color: var(--bc-border); }'],
    ['border-bottom', '.card { border-bottom: 1px solid var(--bc-border); }'],
    ['border-bottom-width', '.card { border-bottom-width: 1px; }'],
    ['border-bottom-style', '.card { border-bottom-style: solid; }'],
    ['border-bottom-color', '.card { border-bottom-color: var(--bc-border); }'],
  ])('rejects the physical property %s', async (property, code) => {
    expect(await rulesFiredFor(code), property).toContain('property-disallowed-list');
  });

  it.each([
    ['text-align: left', '.card { text-align: left; }'],
    ['float: right', '.card { float: right; }'],
  ])('rejects the physical direction in %s', async (_case, code) => {
    expect(await rulesFiredFor(code)).toContain('declaration-property-value-disallowed-list');
  });

  it.each([
    ['margin-inline-start', '.card { margin-inline-start: var(--mantine-spacing-sm); }'],
    ['padding-block-end', '.card { padding-block-end: var(--mantine-spacing-sm); }'],
    ['inset-inline-start', '.card { inset-inline-start: 0; }'],
    ['inline-size', '.card { inline-size: 100%; }'],
    ['text-align: start', '.card { text-align: start; }'],
    ['border-block-end', '.card { border-block-end: 1px solid var(--bc-border); }'],
    ['border-block-start-color', '.card { border-block-start-color: var(--bc-border); }'],
  ])('accepts the logical form %s', async (_case, code) => {
    expect(await rulesFiredFor(code)).toEqual([]);
  });
});

describe('the token declaration files are the only place a literal is legal', () => {
  const LITERAL = ':root { --bc-probe: #1971c2; }';

  it.each([
    ['packages/client/src/app/styles/tokens.css', 'the tokens are declared here'],
    ['packages/client/src/app/global.css', 'the reset is declared here'],
  ])('exempts %s, because %s', async (path) => {
    expect(await rulesFiredFor(LITERAL, join(repoRoot, path))).toEqual([]);
  });

  /**
   * The exemption is a list of two paths, not a directory. A glob over `app/styles/**` would hand
   * the next stylesheet dropped beside `tokens.css` a standing permission to hard-code a colour,
   * and nobody would ever see it happen.
   */
  it.each([
    'packages/client/src/app/styles/elevation.css',
    'packages/client/src/app/app-shell.module.css',
  ])('does not extend the exemption to %s', async (path) => {
    expect(await rulesFiredFor(LITERAL, join(repoRoot, path))).toContain('color-no-hex');
  });

  it('names both exempt files in the config, and no third one', () => {
    const config = readRepoFile('stylelint.config.js');
    const [, block] = /const TOKEN_DECLARATION_FILES = \[([^\]]*)\]/.exec(config) ?? [];

    expect(block, 'the exemption list is no longer a named constant').toBeDefined();
    expect([...(block ?? '').matchAll(/'([^']+)'/g)].map(([, path]) => path)).toEqual([
      'packages/client/src/app/styles/tokens.css',
      'packages/client/src/app/global.css',
    ]);
  });
});

/**
 * Everything above proves the rules fire. This proves the command that runs them is reached, and —
 * the failure this repository has now paid for five times — that turbo re-reads the files it
 * judges. `inputs` is an allow-list: a task whose list omits the stylesheets reports a cached PASS
 * over CSS it never opened, and the gate becomes a decoration that costs CI minutes.
 */
describe('the stylelint gate is wired so that it cannot report a cached pass', () => {
  const STYLELINT_TASK = '//#stylelint';

  it('is exposed as a root script', () => {
    expect(rootScripts().stylelint).toContain('stylelint');
  });

  it('is declared as a turbo task', () => {
    expect(turbo().tasks[STYLELINT_TASK]).toBeDefined();
  });

  /**
   * Attached to `lint` rather than added to the command line of CI. `rules/ci-before-push.mdc` names
   * the four tasks a contributor must run, and `test/ci/workflow.test.ts` asserts CI runs that set
   * and no more — so a fifth task would have to be added to the rule, which is not this change's
   * file to edit, or declared an "extra" in CI, which would be a lie about a check that costs
   * milliseconds and needs nothing. A stylesheet linter is part of linting; hanging it off `lint`
   * makes `pnpm turbo run typecheck lint build test` run it locally and in CI with no new entry
   * anywhere, exactly as `//#lint:repo` already does for the files outside `packages/**`.
   */
  it('runs as part of `lint`, so the pre-push command and CI both reach it', () => {
    expect(turbo().tasks.lint?.dependsOn).toContain(STYLELINT_TASK);
  });

  it('hashes the config, so a rule turned off invalidates the cache', () => {
    expect(turbo().tasks[STYLELINT_TASK]?.inputs ?? []).toContain('stylelint.config.js');
  });

  /**
   * The drift guard. The task hashes a glob and the script lints a glob; if the two are ever
   * different strings, a stylesheet can be linted by the command and hashed by nothing — or hashed
   * and never linted. Comparing them by identity is the only form of this check that cannot rot.
   */
  it('hashes exactly the stylesheets its command lints', () => {
    const script = rootScripts().stylelint ?? '';
    const globs = [...script.matchAll(/"([^"]+)"/g)].map(([, glob]) => glob);

    expect(globs.length, `no quoted glob in the stylelint script: ${script}`).toBeGreaterThan(0);
    expect(
      globs.filter((glob) => !(turbo().tasks[STYLELINT_TASK]?.inputs ?? []).includes(glob)),
    ).toEqual([]);
  });

  /** This suite reads the config, so `//#test:repo` has to re-read it too. */
  it('hashes the config for the repository suite as well', () => {
    expect(turbo().tasks['//#test:repo']?.inputs ?? []).toContain('stylelint.config.js');
  });

  it('produces no build output, so nothing is restored in place of a run', () => {
    expect(turbo().tasks[STYLELINT_TASK]?.outputs ?? []).toEqual([]);
  });
});
