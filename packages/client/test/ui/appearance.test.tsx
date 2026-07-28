import { screen, waitFor } from '@testing-library/react';
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

    expect(screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual([
      'auto',
      'light',
      'dark',
    ]);
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
