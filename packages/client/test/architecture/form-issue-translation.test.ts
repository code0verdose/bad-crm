/**
 * @vitest-environment node
 *
 * A form that hands `zodFormResolver` straight to `validate` never renders at all.
 *
 * Every schema in this repository answers with a **key** rather than a sentence
 * (`rules/i18n.mdc` §1): `validation.email.invalid`, `teams.field.slugInvalid`. `zodFormResolver`
 * wraps that key with the bound that refused it and answers with an **object** per field;
 * `@mantine/form` hands whatever it was given to React as the field's message. So a form missing
 * `translateFormIssues` throws «Objects are not valid as a React child» the first time a field
 * fails — measured, not assumed, against `TextInput error={{ key }}` under a `MantineProvider`.
 *
 * **That is not the state this gate was written for, and the difference is worth stating.** Until
 * 2026-09-06 the resolver answered with the bare key, Mantine rendered it verbatim, and the product
 * refused in dotted lowercase in both languages while every test stayed green — the client suite
 * runs in `cimode`, where `t(key)` **is** the key, so a form that forgot to translate rendered byte
 * for byte like one that remembered. Twelve forms shipped that way. The object made the same
 * mistake loud; this file is what keeps it from having to be made at all, and it costs nothing to
 * keep.
 *
 * **The rule, stated so it is checkable:** a source file that *calls* `zodFormResolver(` also calls
 * `translateFormIssues(`, and no source file calls Mantine's own `schemaResolver(` — the built-in
 * one throws away the bound a message interpolates, which is the whole reason the shared resolver
 * exists, and a form written from the older prose would otherwise slip past this file unnamed.
 * Same file for both halves, because that is where the resolver's answer is available and where `t`
 * already is. A form that translates by some other mechanism is not covered — and should not be
 * written without extending the detector below, which is the point of the rule being one sentence
 * rather than a heuristic.
 *
 * **Why the detector strips comments and why that is not decoration.** Prose about a rule is the
 * thing most likely to mention the rule, and this repository explains itself at length: measured on
 * the tree of 2026-09-06, a naive grep for the resolver's name reports `zod-form-resolver.util.ts`
 * and `employee-profile.schema.ts`, neither of which calls anything — both merely name it while
 * explaining themselves. Stripping comments and looking for a *call* under `src/` reports the
 * fourteen forms that exist and no false positive.
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
 * the defect in prose, naming `zodFormResolver` while doing so. A file explaining why the resolver
 * must be translated must not become a violation because of its own explanation.
 */
const stripComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');

/** A call, not a mention: the name with its parenthesis, after the comments are gone. */
const CALLS_RESOLVER = /\bzodFormResolver\s*\(/;
const CALLS_TRANSLATION = /\btranslateFormIssues\s*\(/;
/** Mantine's own, which the shared resolver replaced — see the rule in the docstring above. */
const CALLS_LIBRARY_RESOLVER = /\bschemaResolver\s*\(/;

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
          '/** about zodFormResolver() */',
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
      'validate: SharedLib.zodFormResolver(loginFormSchema),',
      true,
    ],
    [
      'a resolver whose answer is translated',
      'validate: (values) => translateFormIssues(zodFormResolver(loginFormSchema)(values), t),',
      false,
    ],
    [
      'a docblock that only names the call',
      '/** `validate: zodFormResolver(schema)` prints the key. */\nconst form = useForm({});',
      false,
    ],
    ['a form with no schema at all', 'validate: { email: isEmail() },', false],
  ])('%s → flagged: %s', (_case, source, expected) => {
    expect(untranslatedResolver(source)).toBe(expected);
  });

  /**
   * The library-resolver half has nothing to match in the tree today, which is the point of it and
   * also what would let a broken regex sit here green forever.
   */
  it.each([
    ['a call to the resolver of the library', 'validate: schemaResolver(loginFormSchema),', true],
    [
      'a docblock naming it while explaining the rule',
      '// why not schemaResolver()\nconst a = 1;',
      false,
    ],
    ['the shared resolver', 'validate: zodFormResolver(loginFormSchema)(values),', false],
  ])('CONTROL: %s → banned: %s', (_case, source, expected) => {
    expect(CALLS_LIBRARY_RESOLVER.test(stripComments(source))).toBe(expected);
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

it('no form reaches for the resolver of the library', () => {
  const offenders = sourceFiles()
    .filter((path) => CALLS_LIBRARY_RESOLVER.test(stripComments(readFileSync(path, 'utf8'))))
    .map(relative);

  expect(offenders).toEqual([]);
});

it('every form translates what its resolver returned', () => {
  const offenders = sourceFiles()
    .filter((path) => untranslatedResolver(readFileSync(path, 'utf8')))
    .map(relative);

  expect(offenders).toEqual([]);
});
