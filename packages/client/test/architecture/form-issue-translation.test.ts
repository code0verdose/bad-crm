/**
 * @vitest-environment node
 *
 * A form that hands `schemaResolver` straight to `validate` prints an i18n key under the field.
 *
 * Every schema in this repository answers with a **key** rather than a sentence
 * (`rules/i18n.mdc` §1): `validation.email.invalid`, `teams.field.slugInvalid`. `@mantine/form`
 * renders what the resolver returned, verbatim. So `validate: schemaResolver(schema)` ships a
 * product whose fields refuse in dotted lowercase, in both languages, and nothing else in the tree
 * says so — the client suite runs in `cimode`, where `t(key)` **is** the key, so a form that forgot
 * to translate renders byte for byte like one that remembered and an assertion on
 * `validation.email.invalid` passes either way.
 *
 * `packages/client/test/i18n/pseudo-locale.test.tsx` proves the sentence for each form that exists
 * today. This file is what keeps the next form from being written without one: the pseudo-locale
 * case has to be added by hand, and a class that has already recurred four times in a month is not
 * held by anybody remembering to add a case.
 *
 * **The rule, stated so it is checkable:** a source file that *calls* `schemaResolver(` also calls
 * `translateFormIssues(`. Same file, because that is where the resolver's answer is available and
 * where `t` already is. A form that translates by some other mechanism is not covered — and should
 * not be written without extending the detector below, which is the point of the rule being one
 * sentence rather than a heuristic.
 *
 * **Why the detector strips comments and why that is not decoration.** Measured on the tree this
 * gate was written against: the naive form — grep the package for `schemaResolver`, subtract files
 * naming `translateFormIssues` — reported 13 files, of which 12 were the defect and one was a test
 * file that merely *names* the symbol while explaining it. That is the false positive a gate dies
 * of: prose about a rule is the thing most likely to mention the rule, and this repository explains
 * itself at length. Stripping comments and looking for a *call* under `src/` reported 12 files and
 * 12 defects. A thirteenth form landed from a parallel branch while the change was being made, was
 * named by this gate the moment it appeared, and was fixed with the same one line.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const sourceFiles = (directory: string = SRC): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
    // A schema's own unit test calls neither of these, but a future one asserting what the resolver
    // produces would name both — and a test is not a screen anybody reads a message on.
    if (/\.test\.tsx?$/.test(entry.name)) return [];

    return [path];
  });

const relative = (path: string): string => path.slice(SRC.length + 1);

/**
 * Comments are cut out, for the reason this whole gate exists in a repository whose files explain
 * themselves at length: `translate-form-issues.util.ts` and every form fixed by this change describe
 * the defect in prose, naming `schemaResolver` while doing so. A file explaining why the resolver
 * must be translated must not become a violation because of its own explanation.
 */
const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');

/** A call, not a mention: `schemaResolver(` with the parenthesis, after the comments are gone. */
const CALLS_RESOLVER = /\bschemaResolver\s*\(/;
const CALLS_TRANSLATION = /\btranslateFormIssues\s*\(/;

const untranslatedResolver = (source: string): boolean => {
  const code = stripComments(source);

  return CALLS_RESOLVER.test(code) && !CALLS_TRANSLATION.test(code);
};

describe('the detector (CONTROL — without this block the check below passes on an empty set)', () => {
  /**
   * The stripper is the one step between the tree and the verdict whose breakage is silent: it
   * returns a string whatever happens, and an empty string matches no pattern, so a stripper that
   * ate the source would turn this gate green having read nothing.
   */
  it('leaves the code between and after comments', () => {
    expect(
      stripComments(
        [
          '/** about schemaResolver() */',
          'const a = 1;',
          '// and about translateFormIssues()',
          'const b = 2;',
        ].join('\n'),
      ).replaceAll(/\s+/g, ' '),
    ).toBe(' const a = 1; const b = 2;');
  });

  it.each([
    [
      'a resolver wired straight into validate',
      'validate: schemaResolver(loginFormSchema, { sync: true }),',
      true,
    ],
    [
      'a resolver whose answer is translated',
      'validate: (values) => translateFormIssues(schemaResolver(loginFormSchema)(values), t),',
      false,
    ],
    [
      'a docblock that only names the call',
      '/** `validate: schemaResolver(schema)` prints the key. */\nconst form = useForm({});',
      false,
    ],
    ['a form with no schema at all', 'validate: { email: isEmail() },', false],
  ])('%s → flagged: %s', (_case, source, expected) => {
    expect(untranslatedResolver(source)).toBe(expected);
  });

  /**
   * And the tree it walks contains what it is looking for. A `sourceFiles` that returned nothing —
   * a renamed directory, a glob that stopped matching — would satisfy the check below in silence.
   */
  it('walks a tree that still calls the resolver', () => {
    const callers = sourceFiles().filter((path) =>
      CALLS_RESOLVER.test(stripComments(readFileSync(path, 'utf8'))),
    );

    expect(callers.length).toBeGreaterThan(5);
  });
});

it('every form translates what its resolver returned', () => {
  const offenders = sourceFiles()
    .filter((path) => untranslatedResolver(readFileSync(path, 'utf8')))
    .map(relative);

  expect(offenders).toEqual([]);
});
