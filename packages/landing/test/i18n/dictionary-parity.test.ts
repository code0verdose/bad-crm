import { describe, expect, it } from 'vitest';

import { EN_COPY } from '@/app/i18n/dictionary-en.constant.js';
import { RU_COPY } from '@/app/i18n/dictionary-ru.constant.js';

type Node = string | number | Node[] | { [key: string]: Node };

/** Every leaf of the dictionary, as `a.b.0.c` paths — the shape both languages must share. */
const paths = (node: Node, prefix = ''): string[] => {
  if (Array.isArray(node)) return node.flatMap((item, index) => paths(item, `${prefix}.${index}`));
  if (typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => paths(value, `${prefix}.${key}`));
  }
  return [prefix];
};

const entries = (node: Node, prefix = ''): [string, string | number][] => {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => entries(item, `${prefix}.${index}`));
  }
  if (typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => entries(value, `${prefix}.${key}`));
  }
  return [[prefix, node]];
};

/**
 * Where an empty string is content rather than an omission: the blank line between the commands and
 * the health checks in the terminal block (the gap is what makes the output readable), and the unit
 * a metric is measured in — most of the six carry neither a prefix nor a suffix.
 */
const ALLOWED_EMPTY = [/^\.selfHost\.terminal\./, /^\.metrics\.items\.\d+\.(prefix|suffix)$/];

/**
 * The type system already refuses a Russian dictionary with a missing key — `RU_COPY` is annotated
 * with a type inferred from `EN_COPY`. What it cannot see is the two failures below, and both have
 * shipped on real projects: an *array* of a different length (the type is `string[]`, so one item
 * fewer compiles), and a value left as an empty string.
 */
describe('the two dictionaries describe the same page', () => {
  it('has the same set of leaf paths in both languages', () => {
    expect(paths(RU_COPY as unknown as Node)).toEqual(paths(EN_COPY as unknown as Node));
  });

  it.each([
    ['en', EN_COPY],
    ['ru', RU_COPY],
  ])('has no empty string in %s', (_language, dictionary) => {
    const empty = entries(dictionary as unknown as Node)
      .filter(
        ([path, value]) =>
          typeof value === 'string' &&
          value.trim() === '' &&
          !ALLOWED_EMPTY.some((allowed) => allowed.test(path)),
      )
      .map(([path]) => path);

    expect(empty).toEqual([]);
  });
});
