import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/app/i18n/locale.provider.js';
import { EN_COPY } from '@/app/i18n/dictionary-en.constant.js';
import { CONSENT_STORAGE_KEY } from '@/shared/lib/consent.util.js';
import { CookieBanner } from '@/widgets/cookie-banner.widget.js';
import { SiteFooter } from '@/widgets/site-footer.widget.js';

/**
 * The cookie banner asks a real question and remembers the answer — both halves of the promise made
 * in `consent.util.ts`. What matters here is observable behaviour: the banner appears once, either
 * button dismisses it with equal weight, the answer survives a remount (a real page load, not just a
 * re-render), and withdrawing it from the footer brings the question back.
 */
describe('the cookie banner', () => {
  it('is shown as a labelled region when no answer is stored yet', () => {
    render(
      <LocaleProvider>
        <CookieBanner />
      </LocaleProvider>,
    );

    expect(screen.getByRole('region', { name: EN_COPY.cookies.title })).toBeInTheDocument();
  });

  it('is not shown at all once an answer is already stored', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, 'necessary');

    render(
      <LocaleProvider>
        <CookieBanner />
      </LocaleProvider>,
    );

    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('accepting stores "all" and dismisses the banner', async () => {
    render(
      <LocaleProvider>
        <CookieBanner />
      </LocaleProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: EN_COPY.cookies.accept }));
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument());

    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('all');
  });

  it('rejecting stores "necessary" and dismisses the banner, same as accepting', async () => {
    render(
      <LocaleProvider>
        <CookieBanner />
      </LocaleProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: EN_COPY.cookies.reject }));
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument());

    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('necessary');
  });

  it('keeps the answer across a remount — a returning visitor is not asked twice', async () => {
    const { unmount } = render(
      <LocaleProvider>
        <CookieBanner />
      </LocaleProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: EN_COPY.cookies.accept }));
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument());
    unmount();

    // A fresh mount reads `localStorage` in its state initialiser, the way a fresh page load would.
    render(
      <LocaleProvider>
        <CookieBanner />
      </LocaleProvider>,
    );

    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});

/**
 * Withdrawing consent from the footer has to be as easy as giving it. The footer clears the stored
 * answer and reloads the page — the reload is what a fresh mount of `CookieBanner` would see, so the
 * assertion here is on the two things the click is actually responsible for: the storage key is gone,
 * and a reload was requested. `location.reload` is not implemented by jsdom, so it is swapped for a
 * spy for the length of this test rather than stubbed globally for the whole suite.
 */
describe('withdrawing consent from the footer', () => {
  const originalLocation = globalThis.location;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: { ...originalLocation, reload: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('clears the stored consent and reloads the page', async () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, 'all');

    render(
      <LocaleProvider>
        <SiteFooter />
      </LocaleProvider>,
    );

    await userEvent.click(
      screen.getByRole('button', { name: EN_COPY.footer.legalLinks.manageCookies }),
    );

    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    expect(globalThis.location.reload).toHaveBeenCalledOnce();
  });
});
