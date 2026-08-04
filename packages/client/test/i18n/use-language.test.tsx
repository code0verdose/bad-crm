import { renderHook, act } from '@testing-library/react';
import i18next from 'i18next';
import { type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedHooks, SharedI18n } from '@shared';

/**
 * The language of a tab, from the three angles a user notices.
 *
 * A first visit must open in the language the browser asks for — the acceptance criterion is
 * literally «no flash of English», and the flash is what happens when the stored value is read after
 * mount instead of during it. A choice must survive a reload, or the switcher is a control that
 * undoes itself. And `<html lang>` must follow, because it is what a screen reader picks a voice
 * from: wrong there, and a Russian page is read aloud with English pronunciation.
 */
const wrapper = ({ children }: { readonly children: ReactNode }) => (
  <I18nextProvider i18n={i18next}>{children}</I18nextProvider>
);

const withNavigator = (language: string): void => {
  vi.stubGlobal('navigator', { language });
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('lang');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // The suite shares one i18next instance, and these cases change its language. Left as `ru`, the
  // next file to run would resolve against a catalogue it never asked for — an order-dependent
  // failure, which is the kind that is debugged by rerunning rather than by reading.
  await i18next.changeLanguage('cimode');
});

describe('useLanguage', () => {
  it('CONTROL: opens in English when the browser asks for nothing it has', () => {
    withNavigator('de');

    const { result } = renderHook(() => SharedHooks.useLanguage(), { wrapper });

    expect(result.current.language).toBe('en');
  });

  /**
   * On the very first render, not after an effect. `useLocalStorage` defaults to reading storage in
   * an effect, which paints one frame in the wrong language and then replaces every string on the
   * screen — the flash the criterion forbids. Asserted by reading the value the first render
   * produced, which is the only place that distinguishes the two.
   */
  it('opens in the browser language on the first render, without a frame of English', () => {
    withNavigator('ru-RU');

    const { result } = renderHook(() => SharedHooks.useLanguage(), { wrapper });

    expect(result.current.language).toBe('ru');
  });

  it('prefers a choice that was made earlier over the browser', () => {
    localStorage.setItem(SharedI18n.LANGUAGE_STORAGE_KEY, JSON.stringify('en'));
    withNavigator('ru-RU');

    const { result } = renderHook(() => SharedHooks.useLanguage(), { wrapper });

    expect(result.current.language).toBe('en');
  });

  it('applies a change immediately and remembers it', () => {
    withNavigator('en');
    const { result } = renderHook(() => SharedHooks.useLanguage(), { wrapper });

    act(() => {
      result.current.setLanguage('ru');
    });

    expect(result.current.language).toBe('ru');
    expect(localStorage.getItem(SharedI18n.LANGUAGE_STORAGE_KEY)).toBe(JSON.stringify('ru'));
  });

  it('tells i18next, so the strings on screen change without a reload', () => {
    withNavigator('en');
    const { result } = renderHook(() => SharedHooks.useLanguage(), { wrapper });

    act(() => {
      result.current.setLanguage('ru');
    });

    expect(i18next.language).toBe('ru');
  });

  it('writes the language onto the document, where a screen reader reads it', () => {
    withNavigator('en');
    const { result } = renderHook(() => SharedHooks.useLanguage(), { wrapper });

    expect(document.documentElement.getAttribute('lang')).toBe('en');

    act(() => {
      result.current.setLanguage('ru');
    });

    expect(document.documentElement.getAttribute('lang')).toBe('ru');
  });
});
