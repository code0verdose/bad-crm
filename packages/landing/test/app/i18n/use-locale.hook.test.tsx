import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { LocaleProvider } from '@/app/i18n/locale.provider.js';

/**
 * The guard, and the reason it is worth a test rather than a coverage exemption.
 *
 * Every string on this page comes through `useLocale`. Without the throw, a component mounted
 * outside `<LocaleProvider>` reads `undefined` and fails somewhere further in — on a property of the
 * copy, in a component that has nothing to do with the mistake. The throw turns that into one
 * sentence naming the actual cause, and a guard nobody has ever run is a guard that may not work.
 */
describe('useLocale', () => {
  it('refuses to answer outside the provider, by name', () => {
    // React logs the error it re-throws; the case is about the message, not about the console.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => renderHook(() => useLocale())).toThrow(/LocaleProvider/);

    consoleError.mockRestore();
  });

  it('CONTROL: answers inside it', () => {
    const { result } = renderHook(() => useLocale(), { wrapper: LocaleProvider });

    expect(result.current.locale).toMatch(/^(en|ru)$/);
    expect(typeof result.current.setLocale).toBe('function');
  });
});
