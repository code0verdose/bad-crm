import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharedI18n } from '@shared';

/**
 * Which language a tab opens in, decided once and in a stated order.
 *
 * The order is the whole content of this: the browser must beat the default, or a Russian-speaking
 * visitor gets English on a product that has Russian; and an unknown language has to land on
 * something rather than on a blank interface — i18next answers a missing catalogue with keys. The
 * saved choice sits above both and is read by `useLocalStorage` inside `useLanguage`, which is why it
 * is absent here.
 *
 * The profile is the step above all of these and is deliberately absent: it arrives with EPIC-012,
 * and `resolveLanguage` takes it as an argument so that adding it later is a call site rather than a
 * rewrite.
 */
const withNavigator = (language: string | undefined): void => {
  vi.stubGlobal('navigator', { language });
};

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('resolveLanguage', () => {
  it('CONTROL: falls back to English when nothing says otherwise', () => {
    withNavigator(undefined);

    expect(SharedI18n.resolveLanguage()).toBe('en');
  });

  it('takes the profile over anything the browser says', () => {
    withNavigator('en-GB');

    expect(SharedI18n.resolveLanguage('ru')).toBe('ru');
  });

  it('ignores a profile language this product does not have', () => {
    withNavigator('ru');

    expect(SharedI18n.resolveLanguage('de')).toBe('ru');
  });

  it.each([
    ['ru-RU', 'ru'],
    ['ru', 'ru'],
    ['en-GB', 'en'],
  ])('reads %s from the browser as %s', (reported, expected) => {
    withNavigator(reported);

    expect(SharedI18n.resolveLanguage()).toBe(expected);
  });

  /**
   * A language the product does not have is not an error and not a blank screen: it is English. The
   * region is dropped before the comparison, so `ru-BY` is Russian — the alternative is a visitor
   * whose browser reports a region we never listed getting a language we do not speak to them in.
   */
  it.each(['de', 'fr-CA', 'zz', ''])('falls back to English for %s', (reported) => {
    withNavigator(reported);

    expect(SharedI18n.resolveLanguage()).toBe('en');
  });

  /**
   * The saved choice is `useLocalStorage`'s business, not this function's — asserted here so the
   * separation is stated rather than assumed. Reading storage in both places would be two answers to
   * one question, and it would need the direct `globalThis.localStorage` access the architecture test
   * forbids across the tree.
   */
  it('does not read the saved choice — that belongs to the hook', () => {
    localStorage.setItem(SharedI18n.LANGUAGE_STORAGE_KEY, JSON.stringify('ru'));
    withNavigator('en-GB');

    expect(SharedI18n.resolveLanguage()).toBe('en');
  });
});
