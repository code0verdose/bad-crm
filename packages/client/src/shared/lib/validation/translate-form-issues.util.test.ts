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
const translate = (key: string): string => `⟦${key}⟧`;

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
        { email: 'validation.email.invalid', password: 'validation.password.too_short' },
        translate,
      ),
    ).toEqual({ email: '⟦validation.email.invalid⟧', password: '⟦validation.password.too_short⟧' });
  });

  it('leaves a path with no issue alone and keeps the paths it was given', () => {
    expect(translateFormIssues({ [NESTED_PATH]: 'validation.email.invalid' }, translate)).toEqual({
      [NESTED_PATH]: '⟦validation.email.invalid⟧',
    });
    expect(translateFormIssues({}, translate)).toEqual({});
  });

  /** A resolver may answer with a node — an element carrying a link — and `t` would stringify it. */
  it('passes anything that is not a string through untouched', () => {
    const node = { type: 'span' };

    expect(translateFormIssues({ terms: node, seen: true }, translate)).toEqual({
      terms: node,
      seen: true,
    });
  });
});
