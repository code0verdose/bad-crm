/**
 * The orphan detector, exercised on sources written for the test rather than on the tree.
 *
 * Everything here is a positive control in one direction or the other, because a scanner of this
 * shape has exactly two failure modes and both of them look like success: a parse that finds no
 * usage calls a live catalogue half orphaned, and a parse that finds usage everywhere reports «0
 * orphaned» over a catalogue nobody reads any more. So every case below states which key is
 * deliberately dead, which one is deliberately alive, and asserts both answers at once.
 *
 * The measured baseline for the first mode is in `naiveOrphaned`: on this repository the
 * `t('…')`-only reading calls 293 of 613 keys orphaned. That number is printed in the report next
 * to the real one so that a future rewrite of the parse has something to be judged against.
 */
import { describe, expect, it } from 'vitest';

import {
  assembledKeys,
  audit,
  isClean,
  keyLiterals,
  naiveKeyLiterals,
  renderReport,
  stripNonCode,
  type AuditInput,
} from '../../scripts/ci/i18n-unused.util.js';

const NAMESPACES = ['common', 'auth', 'validation'];

const input = (patch: Partial<AuditInput> = {}): AuditInput => ({
  namespaces: NAMESPACES,
  catalogue: ['common.retry'],
  screens: [{ path: 'ui/a.tsx', text: "t('common.retry')" }],
  schemas: [],
  ...patch,
});

describe('stripNonCode', () => {
  it('drops a block comment, a line comment and a continuation line of a doc block', () => {
    const stripped = stripNonCode(
      ['/** `auth.gone.away` */', "const a = 'common.retry';", "// 'auth.also.gone'"].join('\n'),
    );

    expect(stripped).toContain('common.retry');
    expect(stripped).not.toContain('auth.gone.away');
    expect(stripped).not.toContain('auth.also.gone');
  });

  /**
   * The false positive that would have shipped: `import enErrors from './locales/en/errors.json'`
   * reads as the key `errors.json` under any regular expression that only knows what a key looks
   * like, and `i18n.config.ts` has fifteen of those lines.
   */
  it('drops an import line, where a file name looks exactly like a key', () => {
    expect(
      stripNonCode("import x from './locales/en/errors.json';\nt('common.retry')"),
    ).not.toContain('errors.json');
  });
});

describe('keyLiterals', () => {
  /**
   * The trap this whole file exists for: keys reach the catalogue through half a dozen shapes and
   * only one of them is `t('…')`. Each line below is a shape that lives in the tree today.
   */
  it.each([
    ['a call', "t('common.retry')"],
    ['a double-quoted attribute', '<p aria-label="common.retry" />'],
    ['a written-out error map', "const M = { rate_limited: 'common.retry' };"],
    ['a key constant', "export const NOTICE_KEY = 'common.retry';"],
    ['a key prop', '<Section titleKey="common.retry" />'],
    ['a Trans element', '<Trans i18nKey="common.retry" />'],
    ['a zod message', "z.string({ error: 'common.retry' })"],
  ])('reads a key out of %s', (_shape, text) => {
    expect(keyLiterals(text, NAMESPACES)).toEqual(['common.retry']);
  });

  /** Anything whose first segment is not a namespace is somebody else's dotted string. */
  it.each([
    ['a query key', "['users.list']"],
    ['an audit action', "'employee.updated'"],
    ['a module path', "'node:fs'"],
  ])('reads nothing out of %s', (_shape, text) => {
    expect(keyLiterals(text, NAMESPACES)).toEqual([]);
  });
});

describe('naiveKeyLiterals', () => {
  it('sees the call and none of the other shapes — the baseline the report quotes', () => {
    const text = ["t('common.retry')", "const K = 'auth.login.title';"].join('\n');

    expect(naiveKeyLiterals(text)).toEqual(['common.retry']);
  });
});

describe('assembledKeys', () => {
  /** `rules/i18n.mdc` §3: a key built at runtime is a key no gate can see. */
  it('names a key assembled from a prefix and a variable', () => {
    expect(assembledKeys('t(`common.${tone}.title`)', NAMESPACES)).toEqual(['common.${…}.title']);
  });

  it('says nothing about a template that starts with something else', () => {
    expect(assembledKeys('`/api/v1/users/${id}`', NAMESPACES)).toEqual([]);
  });
});

describe('audit', () => {
  it('CONTROL: calls a catalogue whose every key is asked for clean', () => {
    const report = audit(input());

    expect(report.orphaned).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.catalogued).toBe(1);
    expect(isClean(report)).toBe(true);
  });

  /** The positive control: a key nothing asks for, beside a key something does. */
  it('names the orphan and leaves the used key alone', () => {
    const report = audit(input({ catalogue: ['common.retry', 'common.forgotten'] }));

    expect(report.orphaned).toEqual(['common.forgotten']);
    expect(isClean(report)).toBe(false);
  });

  /**
   * A key referenced only by a test is an orphan in the product. Counting it as use is how a
   * renamed key keeps its old entry alive for as long as the old test survives — which is why the
   * scanner drops test files and why this is asserted rather than assumed.
   */
  it('does not accept a test file as evidence that a key is used', () => {
    const report = audit(
      input({
        catalogue: ['common.retry', 'common.only-in-a-test'],
        screens: [
          { path: 'ui/a.tsx', text: "t('common.retry')" },
          { path: 'ui/a.test.tsx', text: "screen.getByText('common.only-in-a-test')" },
        ],
      }),
    );

    expect(report.orphaned).toEqual(['common.only-in-a-test']);
  });

  /** Both plural directions: the source asks for the base key, the file carries the forms. */
  it('pairs a plural family with the base key the source asks for', () => {
    const report = audit(
      input({
        catalogue: ['common.selected_one', 'common.selected_many'],
        screens: [{ path: 'ui/a.tsx', text: "t('common.selected', { count })" }],
      }),
    );

    expect(report.orphaned).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  /** The costlier direction: a screen asks for a sentence that does not exist in either language. */
  it('names a key a screen asks for and the catalogue does not have', () => {
    const report = audit(input({ screens: [{ path: 'ui/a.tsx', text: "t('auth.login.title')" }] }));

    expect(report.missing).toEqual(['auth.login.title (ui/a.tsx)']);
    expect(isClean(report)).toBe(false);
  });

  /**
   * A shared zod schema names its message key in `packages/shared`, where no screen can be seen.
   * The key counts as used — otherwise `validation.email.invalid`, which only a schema names,
   * reads as an orphan — but a schema key with no sentence is *deferred*, not broken: those are
   * the checks no form reaches yet — money, durations, the page size of a list nothing imports —
   * so the key is reported and does not fail the run. Which of them may stay that way is decided
   * next door, by the `AWAITING_A_SENTENCE` registry of `catalogue-parity.test.ts`.
   */
  it('accepts a schema as evidence of use and defers a schema key with no sentence', () => {
    const report = audit(
      input({
        catalogue: ['common.retry', 'validation.email.invalid'],
        schemas: [
          {
            path: 'validation/email.schema.ts',
            text: "z.email({ error: 'validation.email.invalid' })",
          },
          {
            path: 'validation/slug.schema.ts',
            text: "z.string({ error: 'validation.slug.invalid' })",
          },
        ],
      }),
    );

    expect(report.orphaned).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.deferred).toEqual(['validation.slug.invalid (validation/slug.schema.ts)']);
    expect(isClean(report)).toBe(true);
  });

  it('fails on a key assembled at runtime', () => {
    const report = audit(
      input({ screens: [{ path: 'ui/a.tsx', text: 't(`common.${tone}.retry`)' }] }),
    );

    expect(report.assembled).toEqual(['common.${…}.retry (ui/a.tsx)']);
    expect(isClean(report)).toBe(false);
  });

  it('counts what a `t()`-only reading would have called orphaned', () => {
    const report = audit(
      input({
        catalogue: ['common.retry', 'common.title'],
        screens: [{ path: 'ui/a.tsx', text: "t('common.retry')\nconst K = 'common.title';" }],
      }),
    );

    expect(report.orphaned).toEqual([]);
    expect(report.naiveOrphaned).toEqual(['common.title']);
  });
});

describe('renderReport', () => {
  it('puts the counts in a table and the calibration beside them', () => {
    const markdown = renderReport(
      audit(
        input({
          catalogue: ['common.retry', 'common.title'],
          screens: [{ path: 'ui/a.tsx', text: "t('common.retry')\nconst K = 'common.title';" }],
        }),
      ),
    );

    expect(markdown).toContain('## Unused translations');
    expect(markdown).toContain('| Catalogued | 2 |');
    expect(markdown).toContain('| Orphaned | 0 |');
    expect(markdown).toContain('| Orphaned by a `t()`-only reading | 1 |');
  });

  it('names every orphan it found', () => {
    const markdown = renderReport(audit(input({ catalogue: ['common.retry', 'common.gone'] })));

    expect(markdown).toContain('- orphaned: common.gone');
  });

  it('says so plainly when there is nothing to report', () => {
    expect(renderReport(audit(input()))).toContain(
      'Every catalogued key is asked for by the product.',
    );
  });
});
