import { describe, expect, it } from 'vitest';

import { translateFormIssues } from './translate-form-issues.util.js';

/**
 * The step between a schema and a field label — and the reason it exists is a defect nothing else
 * in the suite can see.
 *
 * A schema answers with an i18n key, Mantine renders what it is given, and the client tests run in
 * `cimode` where `t(key)` returns the key: a form that never translates renders **identically** to
 * one that does, in every test in the tree. So the translation is asserted here, against a
 * substitute for `t` that actually changes the string.
 */
const translate = (key: string, values: Readonly<Record<string, unknown>>): string =>
  Object.keys(values).length === 0 ? `⟦${key}⟧` : `⟦${key}|${JSON.stringify(values)}⟧`;

/**
 * Assembled rather than written as a literal, and that is not style: `catalogue-parity.test.ts`
 * scans the source for anything shaped like a dotted key in quotes — comments included — so writing
 * the nested path out as a quoted literal here would report it as a translation key the interface
 * asks for and no catalogue has.
 */
const NESTED_PATH = ['owner', 'email'].join('.');

describe('translating the issues a schema produced', () => {
  it('turns every key into the sentence it names', () => {
    expect(
      translateFormIssues(
        {
          email: { key: 'validation.email.invalid' },
          password: { key: 'validation.password.too_short' },
        },
        translate,
      ),
    ).toEqual({ email: '⟦validation.email.invalid⟧', password: '⟦validation.password.too_short⟧' });
  });

  /**
   * The half that makes «at most 120 characters» possible without the 120 living in the catalogue:
   * the bound travels from the check that failed into the sentence that reports it.
   */
  it('hands the sentence the numbers the failed check carried', () => {
    expect(
      translateFormIssues(
        { name: { key: 'teams.field.nameTooLong', values: { count: 120 } } },
        translate,
      ),
    ).toEqual({ name: '⟦teams.field.nameTooLong|{"count":120}⟧' });
  });

  it('leaves a path with no issue alone and keeps the paths it was given', () => {
    expect(
      translateFormIssues({ [NESTED_PATH]: { key: 'validation.email.invalid' } }, translate),
    ).toEqual({ [NESTED_PATH]: '⟦validation.email.invalid⟧' });
    expect(translateFormIssues({}, translate)).toEqual({});
  });

  /**
   * A resolver may answer with a node — an element carrying a link — and `t` would stringify it.
   *
   * The element **with a key** is the case worth writing down: React puts `key` on the element
   * itself, so `<a key="terms">` has a string exactly where an issue has one. A guard that asked
   * only «is there a string `key`» would translate the element and render `[object Object]`.
   */
  it('passes anything that is not an issue through untouched', () => {
    const node = { type: 'span' };
    const keyedElement = {
      // Assembled for the same reason as `NESTED_PATH` above: written out, React's own marker is
      // shaped exactly like a translation key and `catalogue-parity.test.ts` reports it as one.
      $$typeof: Symbol.for(['react', 'transitional', 'element'].join('.')),
      key: 'terms',
      type: 'a',
    };

    expect(
      translateFormIssues({ terms: node, keyed: keyedElement, seen: true, none: null }, translate),
    ).toEqual({ terms: node, keyed: keyedElement, seen: true, none: null });
  });
});
