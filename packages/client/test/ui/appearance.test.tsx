import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderApp } from '../support/render-app.util.js';

/**
 * The theme switch, end to end: the choice, the document, and what survives a reload.
 *
 * Mantine owns both the attribute and the storage, and that is the point — the alternative is a
 * second writer for one setting, which shows up as a theme that reverts on the next page or flashes
 * white before the stylesheet catches up (`rules/design-system.mdc` §4).
 */

const MANTINE_STORAGE_KEY = 'mantine-color-scheme-value';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-mantine-color-scheme');
});

describe('the colour scheme switch', () => {
  it('offers system, light and dark, in that order', async () => {
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    // Scoped to this control. A document-wide `getAllByRole('radio')` also collects the language
    // switch beside it, and the assertion would then be about the topbar rather than about the
    // colour scheme — it broke the moment a second segmented control appeared, which is the point.
    const control = screen.getByRole('radiogroup', { name: 'common.appearance.colorScheme.aria' });

    expect(
      within(control)
        .getAllByRole('radio')
        .map((radio) => (radio as HTMLInputElement).value),
    ).toEqual(['auto', 'light', 'dark']);
  });

  it('applies the choice to the document immediately', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await user.click(screen.getByRole('radio', { name: 'common.appearance.colorScheme.dark' }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', 'dark');
    });
  });

  it('remembers the choice for the next session', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await user.click(screen.getByRole('radio', { name: 'common.appearance.colorScheme.dark' }));

    await waitFor(() => {
      expect(localStorage.getItem(MANTINE_STORAGE_KEY)).toBe('dark');
    });
  });

  /** `auto` is the default and has to be reachable again after an explicit choice. */
  it('goes back to following the system', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await user.click(screen.getByRole('radio', { name: 'common.appearance.colorScheme.dark' }));
    await user.click(screen.getByRole('radio', { name: 'common.appearance.colorScheme.auto' }));

    await waitFor(() => {
      expect(localStorage.getItem(MANTINE_STORAGE_KEY)).toBe('auto');
    });
  });
});

describe('density', () => {
  /**
   * The shell publishes the mode as an attribute and `tokens.css` keys `--bc-row-height` off it, so
   * a dense table needs neither a prop nor a context to know how tall its rows are.
   */
  it('is comfortable by default and announced on the shell', async () => {
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    expect(document.querySelector<HTMLElement>('[data-bc-density]')).toHaveAttribute(
      'data-bc-density',
      'comfortable',
    );
  });

  it('restores a stored preference without a frame at the wrong height', async () => {
    localStorage.setItem('bc-density', JSON.stringify('compact'));

    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    expect(document.querySelector<HTMLElement>('[data-bc-density]')).toHaveAttribute(
      'data-bc-density',
      'compact',
    );
  });
});

/**
 * The language switch, which is the one appearance control that has to work *before* signing in.
 *
 * Somebody who cannot read the sign-in form cannot sign in to reach a setting page, so «available
 * on public screens» is not a nicety here — it is the difference between a product that has two
 * languages and a product that has one until you already speak the other.
 */
describe('the language switch', () => {
  it('offers English and Russian', async () => {
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    const control = screen.getByRole('radiogroup', { name: 'common.appearance.language.aria' });

    expect(
      within(control)
        .getAllByRole('radio')
        .map((radio) => (radio as HTMLInputElement).value),
    ).toEqual(['en', 'ru']);
  });

  it('applies the choice to the document immediately, without a reload', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await user.click(screen.getByRole('radio', { name: 'common.appearance.language.ru' }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('lang', 'ru');
    });
  });

  it('remembers the choice for the next session', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await user.click(screen.getByRole('radio', { name: 'common.appearance.language.ru' }));

    await waitFor(() => {
      expect(localStorage.getItem('bc-language')).toBe('"ru"');
    });
  });

  /**
   * The acceptance criterion the whole story turns on. Asserted on all three public screens rather
   * than one, because «the switcher is on the sign-in page» is exactly the kind of statement that
   * stays true while the two recovery screens quietly lose it.
   */
  it.each(['/login', '/forgot-password', '/reset-password/tok'])(
    'is reachable on %s, where no profile exists yet',
    async (path) => {
      renderApp({ path, status: 'anonymous' });
      await screen.findByRole('main');

      expect(
        screen.getByRole('radiogroup', { name: 'common.appearance.language.aria' }),
      ).toBeInTheDocument();
    },
  );

  /**
   * CONTROL: the colour-scheme switch is the *other* radiogroup on the same screen. Without this,
   * a query that accidentally matched it would make every assertion above pass while the language
   * control did not exist at all.
   */
  it('CONTROL: is a different control from the colour scheme', async () => {
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    const language = screen.getByRole('radiogroup', { name: 'common.appearance.language.aria' });
    const scheme = screen.getByRole('radiogroup', { name: 'common.appearance.colorScheme.aria' });

    expect(language).not.toBe(scheme);
  });
});
