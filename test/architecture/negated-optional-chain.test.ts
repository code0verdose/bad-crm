import { describe, expect, it } from 'vitest';

import {
  listRepoFiles,
  PACKAGE_DIRS,
  readRepoFile,
  repoEntryNames,
} from '../repo/repo-fixture.util.js';

/**
 * `expect(x?.y).not.toBe…` is satisfied by the very outcome it forbids.
 *
 * When `x` is absent, `x?.y` is `undefined`, and `undefined` is not null and is not the password —
 * so the negated matcher passes. The assertion then says «the bad thing did not happen» while
 * proving only «nothing happened», and those are the same sentence exactly when the code under test
 * broke badly enough to produce nothing at all.
 *
 * Not a hypothesis. Proven on 2026-08-30 in
 * `packages/server/test/integration/http/reset-user-mfa.test.ts`: hoisting `enrollment.disable(...)`
 * above the policy call in `reset-user-mfa.use-case.ts` wiped the owner's second factor, returned
 * 403 — and the case asserting that nothing about the owner moved stayed green, because the finder
 * answered `null` and `state?.enabledAt` was `undefined`. Sixty-two sites had the shape; this file
 * exists so the sixty-third is caught the day it is written rather than the day it matters.
 *
 * **Only negated matchers.** `expect(x?.y).toBe(1)` carries no such trap: absence makes the value
 * `undefined`, and `undefined` fails a positive matcher, which is the outcome we want. The defect
 * is the conjunction of an optional read and a negation, so that is what is forbidden.
 *
 * **Why the whole shape, when only half of it is silent today.** Measured on vitest 4.1.10, not
 * assumed — the probe is `MEASURED` below. Against `undefined`, `not.toBe`, `not.toEqual`,
 * `not.toStrictEqual`, `not.toBeNull`, `not.toBeInstanceOf` and `not.toBeTruthy` pass in silence,
 * while `not.toContain`, `not.toMatch`, `not.toHaveProperty`, `not.toHaveLength` and
 * `not.toBeGreaterThan` throw a `TypeError` and do fail the run. Banning only the silent half would
 * be a rule about the assertion library's current implementation: which matchers happen to reject a
 * non-collection is not a decision this repository made, and an upgrade may change it. It would
 * also be one keystroke from useless — `?? ''`, `?? {}` and `?? []` turn every thrower into a
 * silent pass, TypeScript's strict mode regularly asks for exactly that fallback, and four of the
 * sixty-two already had it.
 *
 * **No allow-list.** An assertion that is honestly about something that may be absent can say so
 * directly — narrow first (`assert(x !== null, …)` from vitest narrows the type; `expect(x).not.
 * toBeNull()` does not) and then read the field, or state the whole claim positively
 * (`toEqual([expect.not.stringContaining(secret)])`, which an empty list fails). Every one of the
 * sixty-two was expressible without the shape, so an exemption list would only ever hold the sites
 * nobody wanted to think about.
 */

/** Where test sources live: the root suite, plus `src`/`test`/`tests` of every package. */
const testRoots = (): string[] => [
  'test',
  ...Object.values(PACKAGE_DIRS).flatMap((dir) =>
    repoEntryNames(dir)
      .filter((name) => name === 'src' || name === 'test' || name === 'tests')
      .map((name) => `${dir}/${name}`),
  ),
];

const IS_TEST_FILE = /\.(?:test|spec)\.tsx?$/;

const testFiles = (): string[] =>
  testRoots()
    .flatMap((root) => listRepoFiles(root))
    .filter((path) => IS_TEST_FILE.test(path))
    .sort();

/**
 * Blanks comments and the *contents* of string literals, keeping every offset where it was.
 *
 * Three requirements meet here, and each one kills a simpler implementation:
 *
 * 1. **Comments must go.** This very file spells the forbidden shape in its prose a dozen times;
 *    a scanner that read comments would report itself.
 * 2. **String contents must go too, but the quotes must stay.** `expect(url).not.toContain('a?.b')`
 *    is innocent — the `?.` is data. Deleting the literal outright would also unbalance the
 *    parentheses that the argument matcher counts, since `'f(x)'` is one paren, not a pair.
 * 3. **`${…}` inside a template literal is code and must survive.** One of the sixty-two reads
 *    `expect(\`${mail?.subject ?? ''}\`).not.toContain(token)` — the trap lives entirely inside the
 *    interpolation, so a blanket blanking of template literals would have missed it.
 *
 * Offsets are preserved (blanks in, blanks out, newlines kept) so a finding can name its line.
 */
const blankNonCode = (source: string): string => {
  const out = [...source];
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };

  let index = 0;

  while (index < source.length) {
    const here = source[index];
    const next = source[index + 1];

    if (here === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (here === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (here === "'" || here === '"') {
      const quote = here;
      let cursor = index + 1;

      while (cursor < source.length && source[cursor] !== quote) {
        cursor += source[cursor] === '\\' ? 2 : 1;
      }

      blank(index + 1, Math.min(cursor, source.length));
      index = cursor + 1;
      continue;
    }

    if (here === '`') {
      index = blankTemplate(source, out, blank, index);
      continue;
    }

    index += 1;
  }

  return out.join('');
};

/**
 * Blanks the literal chunks of one template literal and leaves its `${…}` expressions as code.
 * Returns the offset just past the closing backtick.
 */
const blankTemplate = (
  source: string,
  out: string[],
  blank: (from: number, to: number) => void,
  start: number,
): number => {
  let cursor = start + 1;
  let chunkStart = cursor;

  while (cursor < source.length) {
    const here = source[cursor];

    if (here === '\\') {
      cursor += 2;
      continue;
    }

    if (here === '`') {
      blank(chunkStart, cursor);
      return cursor + 1;
    }

    if (here === '$' && source[cursor + 1] === '{') {
      blank(chunkStart, cursor);

      // Walk the interpolation with a brace counter; a nested template inside it recurses.
      let depth = 1;
      cursor += 2;

      while (cursor < source.length && depth > 0) {
        const inner = source[cursor];

        if (inner === '`') {
          cursor = blankTemplate(source, out, blank, cursor);
          continue;
        }

        if (inner === '{') depth += 1;
        if (inner === '}') depth -= 1;
        cursor += 1;
      }

      chunkStart = cursor;
      continue;
    }

    cursor += 1;
  }

  blank(chunkStart, source.length);
  return source.length;
};

/** Offset of the `)` closing the `(` at `open`, or the end of the source if it is unbalanced. */
const closingParen = (blanked: string, open: number): number => {
  let depth = 0;

  for (let index = open; index < blanked.length; index += 1) {
    if (blanked[index] === '(') depth += 1;
    if (blanked[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return blanked.length;
};

/** The first argument of an argument list — `expect(value, 'why')` puts the subject first. */
const firstArgument = (args: string): string => {
  let depth = 0;

  for (let index = 0; index < args.length; index += 1) {
    const here = args[index];

    if (here === '(' || here === '[' || here === '{') depth += 1;
    if (here === ')' || here === ']' || here === '}') depth -= 1;
    if (here === ',' && depth === 0) return args.slice(0, index);
  }

  return args;
};

const EXPECT_CALL = /\bexpect(?:\.soft)?\s*\(/g;

/** `.not.toX`, optionally behind the promise modifiers, immediately after the closing paren. */
const NEGATED_MATCHER = /^\s*(?:\.resolves|\.rejects)?\s*\.not\s*\.to[A-Za-z]/;

/**
 * Every `expect(<optional chain>)….not.to…` in one source, as `line: text` for the failure message.
 *
 * The check is on the **first argument only**: `expect(value, 'message about a?.b')` is about the
 * value, and the message is prose that happens to be typed inside the call.
 */
const negatedOptionalReads = (source: string): string[] => {
  const blanked = blankNonCode(source);
  const findings: string[] = [];

  for (const match of blanked.matchAll(EXPECT_CALL)) {
    const open = match.index + match[0].length - 1;
    const close = closingParen(blanked, open);

    if (!NEGATED_MATCHER.test(blanked.slice(close + 1, close + 40))) continue;
    if (!firstArgument(blanked.slice(open + 1, close)).includes('?.')) continue;

    const line = blanked.slice(0, open).split('\n').length;

    findings.push(`${line}: ${source.split('\n')[line - 1]?.trim() ?? ''}`);
  }

  return findings;
};

/**
 * The measurement the rule above rests on, kept executable.
 *
 * The premise this file started from — «every negated matcher passes on `undefined`» — is false,
 * and only running it said so: half of them reject a non-collection with a `TypeError` instead.
 * That is a property of the assertion library, not of this repository, so it is pinned here: when
 * an upgrade moves a matcher between the two lists, this fails and names it, rather than quietly
 * widening or narrowing how much of the tree was ever really at risk.
 */
describe('MEASURED: a negated matcher against undefined', () => {
  const absent: unknown = undefined;

  const passesSilently = (assertion: () => void): boolean => {
    try {
      assertion();
      return true;
    } catch {
      return false;
    }
  };

  it.each([
    ['toBe', (): void => expect(absent).not.toBe('x')],
    ['toEqual', (): void => expect(absent).not.toEqual(['a'])],
    ['toStrictEqual', (): void => expect(absent).not.toStrictEqual('x')],
    ['toBeNull', (): void => expect(absent).not.toBeNull()],
    ['toBeInstanceOf', (): void => expect(absent).not.toBeInstanceOf(Date)],
    ['toBeTruthy', (): void => expect(absent).not.toBeTruthy()],
  ])('is satisfied by absence: not.%s', (_name, assertion) => {
    expect(passesSilently(assertion)).toBe(true);
  });

  it.each([
    ['toContain', (): void => expect(absent).not.toContain('a')],
    ['toMatch', (): void => expect(absent).not.toMatch(/a/)],
    ['toHaveProperty', (): void => expect(absent).not.toHaveProperty('a')],
    ['toHaveLength', (): void => expect(absent).not.toHaveLength(1)],
    ['toBeGreaterThan', (): void => expect(absent).not.toBeGreaterThan(1)],
  ])('rejects absence with a TypeError: not.%s', (_name, assertion) => {
    expect(passesSilently(assertion)).toBe(false);
  });

  /** And the keystroke that moves a matcher from the second list to the first. */
  it('is satisfied by absence once a nullish fallback is added', () => {
    expect(
      passesSilently(() => expect((absent as string[] | undefined) ?? []).not.toContain('a')),
    ).toBe(true);
  });
});

describe('the detector', () => {
  it.each([
    ['a plain optional read', 'expect(state?.enabledAt).not.toBeNull();'],
    ['an indexed optional read', 'expect(lines[0]?.fields).not.toHaveProperty("stack");'],
    ['an optional read inside a call', 'expect(JSON.stringify(a?.b)).not.toContain(secret);'],
    ['an optional read behind a message', "expect(a?.b, 'why this matters').not.toEqual(c);"],
    ['an optional read in an interpolation', 'expect(`${m?.text ?? ""}`).not.toContain(token);'],
    ['a promise modifier in between', 'await expect(p?.q).resolves.not.toBe(1);'],
    ['padding around the matcher', 'expect(a?.b) .not .toMatch(/x/);'],
  ])('flags %s', (_case, source) => {
    expect(negatedOptionalReads(source)).toHaveLength(1);
  });

  it.each([
    [
      'a positive matcher, which absence already fails',
      'expect(state?.enabledAt).toBeInstanceOf(Date);',
    ],
    ['a negation over a certain read', 'expect(state.enabledAt).not.toBeNull();'],
    ['an optional chain living in a string', "expect(text).not.toContain('a?.b');"],
    ['an optional chain living in a comment', 'expect(a).not.toBeNull(); // was a?.b once'],
    [
      'an earlier positive expect that happens to read optionally',
      'expect(a?.b).toBe(1);\nexpect(c).not.toBe(2);',
    ],
  ])('stays silent on %s', (_case, source) => {
    expect(negatedOptionalReads(source)).toEqual([]);
  });
});

/**
 * The two steps whose failure is silent: a blanker that ate the code and a walk that found no
 * files both leave the assertion below comparing an empty list with an empty list.
 */
describe('CONTROL', () => {
  it('blanks comments and string bodies while keeping every offset', () => {
    const source = ['/* a?.b */', "const s = 'c?.d';", '// e?.f', 'expect(g?.h).not.toBe(1);'].join(
      '\n',
    );
    const blanked = blankNonCode(source);

    expect(blanked).toHaveLength(source.length);
    expect(blanked).not.toContain('?.b');
    expect(blanked).not.toContain('c?.d');
    expect(blanked).not.toContain('e?.f');
    expect(blanked).toContain('expect(g?.h).not.toBe(1);');
  });

  it('keeps the code inside a template interpolation', () => {
    expect(blankNonCode('`text a?.b ${ m?.n } tail`')).toContain('m?.n');
  });

  it('walks a tree that still has assertions in it after blanking', () => {
    // Not a file count: a fact about the contents. A blanker that emptied the sources would leave
    // every assertion below passing over nothing.
    const withAssertions = testFiles().filter((path) =>
      blankNonCode(readRepoFile(path)).includes('expect('),
    );

    expect(withAssertions.length).toBeGreaterThan(100);
  });

  it('walks the tree this file lives in', () => {
    expect(testFiles()).toContain('test/architecture/negated-optional-chain.test.ts');
  });
});

describe('the test suite', () => {
  it('never negates a matcher over an optional read', () => {
    const offenders = testFiles().flatMap((path) =>
      negatedOptionalReads(readRepoFile(path)).map((finding) => `${path}:${finding}`),
    );

    expect(
      offenders,
      'assert the container is there, then read the field — see the doc block above',
    ).toEqual([]);
  });
});
