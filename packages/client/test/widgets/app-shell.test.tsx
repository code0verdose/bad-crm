import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderApp } from '../support/render-app.util.js';

/**
 * The shell as a keyboard user meets it.
 *
 * Everything asserted here is invisible to a mouse and load-bearing without one: the landmarks a
 * screen reader jumps between, the skip link that saves a tab through the whole menu, `aria-current`
 * on the page you are on, and a drawer that can be closed with `Esc` and gives the focus back.
 * None of it is visible in a screenshot, and all of it is what `rules/a11y.mdc` calls AA.
 */

beforeEach(() => {
  localStorage.clear();
});

describe('landmarks', () => {
  it('exposes a banner, a main region and a named navigation', async () => {
    renderApp({ path: '/dashboard' });

    expect(await screen.findByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'nav.primary.aria' })).toBeInTheDocument();
  });

  it('gives the main region the id the skip link points at', async () => {
    renderApp({ path: '/dashboard' });

    expect(await screen.findByRole('main')).toHaveAttribute('id', 'main');
  });
});

describe('landmark hygiene', () => {
  /**
   * The regression this exists for was found in a browser, not here: `AppShell.Navbar` renders its
   * own `<nav>`, so a `<nav>` inside the sidebar list produced two navigation landmarks nested one
   * in the other, the outer one unnamed (`rules/a11y.mdc` §20). Every assertion in this file passed
   * throughout, because they all asked for the *named* one and found it.
   */
  it('gives every navigation landmark a name', async () => {
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    const unnamed = [...document.querySelectorAll('nav')].filter(
      (nav) => (nav.getAttribute('aria-label') ?? nav.getAttribute('aria-labelledby')) === null,
    );

    expect(unnamed).toEqual([]);
  });

  it('never nests one navigation landmark inside another', async () => {
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    const nested = [...document.querySelectorAll('nav')].filter(
      (nav) => nav.parentElement?.closest('nav') !== null,
    );

    expect(nested).toEqual([]);
  });

  it('has exactly one main region and one banner', async () => {
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('banner')).toHaveLength(1);
  });

  it('passes an axe audit of the whole shell', async () => {
    const { container } = renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    const results = await axe.run(container, {
      // Colours live in a stylesheet jsdom never loads; contrast is measured from the tokens in
      // `test/theme/tokens.test.ts`, where the real values are.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('the skip link', () => {
  it('is the first element the keyboard reaches', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await user.tab();

    expect(document.activeElement).toHaveAttribute('href', '#main');
  });
});

describe('the sidebar', () => {
  it('marks the current route with aria-current, not with colour alone', async () => {
    renderApp({ path: '/dashboard' });
    const nav = await screen.findByRole('navigation', { name: 'nav.primary.aria' });

    expect(within(nav).getByRole('link', { name: 'nav.dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('remembers that it was collapsed, so a reload does not undo the choice', async () => {
    const user = userEvent.setup();
    const first = renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await user.click(screen.getByRole('button', { name: 'nav.sidebar.toggle' }));

    await waitFor(() => {
      expect(localStorage.getItem('bc-sidebar-collapsed')).toBe('true');
    });

    // A second mount is what a reload is, as far as the component is concerned.
    first.unmount();
    renderApp({ path: '/dashboard' });

    expect(await screen.findByRole('button', { name: 'nav.sidebar.toggle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  /**
   * Collapsed, the labels leave the screen — and must not leave the accessibility tree with them.
   * An icon rail whose buttons are called «button» is navigable only by whoever drew the icons.
   */
  it('keeps every item named when it is folded to icons', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await user.click(screen.getByRole('button', { name: 'nav.sidebar.toggle' }));

    const nav = screen.getByRole('navigation', { name: 'nav.primary.aria' });
    expect(within(nav).getByRole('link', { name: 'nav.dashboard' })).toBeInTheDocument();
  });
});

describe('the mobile drawer', () => {
  it('opens from the burger and traps focus inside itself', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await user.click(screen.getByRole('button', { name: 'nav.drawer.toggle' }));

    const drawer = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(drawer).toContainElement(document.activeElement as HTMLElement | null);
    });
  });

  it('closes on Escape and gives the focus back to the burger', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');
    const burger = screen.getByRole('button', { name: 'nav.drawer.toggle' });

    await user.click(burger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(burger);
    });
  });
});
