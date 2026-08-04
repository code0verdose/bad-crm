/**
 * The translation summary, tested on catalogues written for the test rather than on the real ones.
 *
 * A test that read `locales/` would assert whatever the tree happens to contain today — green while
 * the arithmetic is wrong, red when somebody adds a key. The cases here state the shapes that matter
 * and the answers they must produce, so the detector is exercised in its failing direction too:
 * a checker that never reports an unpaired key is indistinguishable from a clean repository.
 */
import { describe, expect, it } from 'vitest';

import {
  flatten,
  isClean,
  isUntranslated,
  renderSummary,
  summarise,
  type CatalogueEntry,
} from '../../scripts/ci/i18n-summary.util.js';

const entries = (tree: Record<string, Record<string, unknown>>) =>
  Object.entries(tree).flatMap(([namespace, subtree]) => flatten(namespace, subtree));

const catalogues = (
  en: Record<string, Record<string, unknown>>,
  ru: Record<string, Record<string, unknown>>,
): ReadonlyMap<string, readonly CatalogueEntry[]> =>
  new Map([
    ['en', entries(en)],
    ['ru', entries(ru)],
  ]);

describe('flatten', () => {
  it('resolves a nested tree the way i18next addresses it', () => {
    expect(
      flatten('common', { appearance: { language: { en: 'English' } }, retry: 'Retry' }),
    ).toEqual([
      { namespace: 'common', key: 'common.appearance.language.en', value: 'English' },
      { namespace: 'common', key: 'common.retry', value: 'Retry' },
    ]);
  });

  it('ignores a value that is neither a string nor a subtree', () => {
    expect(flatten('common', { count: 3, ok: 'Fine' })).toEqual([
      { namespace: 'common', key: 'common.ok', value: 'Fine' },
    ]);
  });
});

describe('isUntranslated', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('counts %s as untranslated', (_case, value) => {
    expect(isUntranslated({ namespace: 'common', key: 'common.a', value })).toBe(true);
  });

  /** What an extractor writes when it has nothing to put there — present, and useless. */
  it('counts a value equal to its own key as untranslated', () => {
    expect(isUntranslated({ namespace: 'common', key: 'common.a', value: 'common.a' })).toBe(true);
  });

  it('CONTROL: leaves a real translation alone', () => {
    expect(isUntranslated({ namespace: 'common', key: 'common.a', value: 'Retry' })).toBe(false);
  });
});

describe('summarise', () => {
  it('reports a clean pair of catalogues as clean', () => {
    const summary = summarise(
      catalogues({ common: { retry: 'Retry' } }, { common: { retry: 'Повторить' } }),
    );

    expect(summary.languages).toEqual([
      { language: 'en', keys: 1, untranslated: [] },
      { language: 'ru', keys: 1, untranslated: [] },
    ]);
    expect(summary.unpaired).toEqual([]);
    expect(isClean(summary)).toBe(true);
  });

  it('names a key one language has and the other does not, in both directions', () => {
    const summary = summarise(
      catalogues(
        { common: { retry: 'Retry', only: 'Only here' } },
        { common: { retry: 'Повторить', other: 'Только тут' } },
      ),
    );

    expect(summary.unpaired).toEqual([
      'common.only (missing in ru)',
      'common.other (missing in en)',
    ]);
    expect(isClean(summary)).toBe(false);
  });

  it('names a key that exists in both and says nothing in one', () => {
    const summary = summarise(
      catalogues({ common: { retry: 'Retry' } }, { common: { retry: '' } }),
    );

    expect(summary.unpaired).toEqual([]);
    expect(summary.languages[1]?.untranslated).toEqual(['common.retry']);
    expect(isClean(summary)).toBe(false);
  });

  it('lists every namespace it saw', () => {
    const summary = summarise(
      catalogues(
        { nav: { home: 'Home' }, common: { retry: 'Retry' } },
        { nav: { home: 'Дом' }, common: { retry: 'Повторить' } },
      ),
    );

    expect(summary.namespaces).toEqual(['common', 'nav']);
  });
});

describe('renderSummary', () => {
  it('puts the counts in a table and the problems underneath', () => {
    const markdown = renderSummary(
      summarise(catalogues({ common: { retry: 'Retry' } }, { common: { retry: '' } })),
    );

    expect(markdown).toContain('| `en` | 1 | 0 |');
    expect(markdown).toContain('| `ru` | 1 | 1 |');
    expect(markdown).toContain('- untranslated (`ru`): common.retry');
  });

  it('says so plainly when there is nothing to report', () => {
    const markdown = renderSummary(
      summarise(catalogues({ common: { retry: 'Retry' } }, { common: { retry: 'Повторить' } })),
    );

    expect(markdown).toContain('Every key is paired and carries a translation.');
  });
});
