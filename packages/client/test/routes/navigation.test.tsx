import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderApp } from '../support/render-app.util.js';

/**
 * The router as a user meets it: the guard, the redirect, the boundaries, the title.
 *
 * `test/routes/guards.test.ts` proves the guards as functions; this proves that they are actually
 * *attached* — to the pathless layout, before the loaders, on the branch they claim to protect. The
 * two failures it catches are the ones a unit test cannot see: a guard that is written and never
 * wired, and a `beforeLoad` that runs after the page has already rendered.
 */

describe('the protected branch', () => {
  it('sends an anonymous visitor to the login screen, carrying where they were going', async () => {
    const { router } = renderApp({ path: '/dashboard', status: 'anonymous' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    // The whole URL, defaults included: what the user gets back is the page they asked for.
    expect(router.state.location.search).toMatchObject({
      redirect: '/dashboard?range=7d&scope=me',
    });
  });

  it('never renders the protected screen on the way to the login page', async () => {
    renderApp({ path: '/dashboard', status: 'anonymous' });

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('auth.login.title');
    expect(screen.queryByText('nav.dashboard')).not.toBeInTheDocument();
  });

  it('lets a signed-in user in', async () => {
    renderApp({ path: '/dashboard', status: 'authenticated' });

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('nav.dashboard');
  });

  it('redirects the root path to the dashboard without leaving a step in the history', async () => {
    const { router } = renderApp({ path: '/', status: 'authenticated' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });
  });
});

describe('the public branch', () => {
  it('keeps a signed-in user off the login form', async () => {
    const { router } = renderApp({ path: '/login', status: 'authenticated' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });
  });

  it('shows the login screen to an anonymous visitor', async () => {
    renderApp({ path: '/login', status: 'anonymous' });

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('auth.login.title');
  });

  /**
   * The recovery screens, and they are here for the reason this file exists: `guards.test.ts` proves
   * `redirectIfAuthed` as a function, and until now nothing proved it was *attached* to
   * `/forgot-password`. Deleting the `beforeLoad` from that route file left the whole suite green.
   *
   * What the guard prevents is a signed-in person ordering themselves a single-use password-reset
   * token by email — a live credential mailed out to an account that did not need one.
   */
  it('keeps a signed-in user off the password recovery form', async () => {
    const { router } = renderApp({ path: '/forgot-password', status: 'authenticated' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });
  });

  it('shows the recovery form to an anonymous visitor', async () => {
    renderApp({ path: '/forgot-password', status: 'anonymous' });

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'auth.forgotPassword.title',
    );
  });

  /**
   * And the opposite, which is a decision rather than an omission: `/reset-password/$token` has **no**
   * guard on purpose. Following a reset link on a second device — a phone, a browser already signed in
   * as somebody else — has to work, because the person following it is the one who cannot get in.
   *
   * Asserted because a decision nobody can see is a decision the next reader will "fix": adding
   * `redirectIfAuthed` here also left the suite green, while sending every signed-in visitor to the
   * dashboard and silently stranding a valid link.
   */
  it('lets a signed-in visitor follow a reset link, deliberately unguarded', async () => {
    const { router } = renderApp({ path: '/reset-password/abc123', status: 'authenticated' });

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'auth.resetPassword.title',
    );
    expect(router.state.location.pathname).toBe('/reset-password/abc123');
  });
});

describe('search parameters', () => {
  it('replaces rubbish with the defaults instead of failing the route', async () => {
    const { router } = renderApp({ path: '/dashboard?range=forever&scope=everyone' });

    await screen.findByRole('main');

    expect(router.state.location.search).toEqual({ range: '7d', scope: 'me' });
  });

  it('keeps a valid combination and hands it to the page', async () => {
    renderApp({ path: '/dashboard?range=30d&scope=org' });

    expect(await screen.findByText('30d · org')).toBeInTheDocument();
  });
});

describe('the boundaries', () => {
  it('answers an unknown path with the not-found screen, inside the shell', async () => {
    renderApp({ path: '/nope' });

    expect(await screen.findByText('errors.not_found.title')).toBeInTheDocument();
    // Inside the shell, not alone on a blank page: the way out has to still be on screen.
    expect(screen.getByRole('navigation', { name: 'nav.primary.aria' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  /** An unknown URL must not confirm that this installation exists to someone with no session. */
  it('sends an anonymous visitor from an unknown path to the login screen', async () => {
    const { router } = renderApp({ path: '/nope', status: 'anonymous' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
  });

  /** The one link on that screen has to lead somewhere that exists. */
  it('offers a way back from the not-found screen', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({ path: '/nope' });

    await user.click(await screen.findByRole('link', { name: 'errors.not_found.action' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });
  });
});

describe('the route announcer', () => {
  it('names the page in the document title', async () => {
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    await waitFor(() => {
      expect(document.title).toBe('nav.dashboard · Bad CRM');
    });
  });

  /**
   * A navigation in a single-page application changes nothing a screen reader notices by itself.
   * Moving focus to the new `h1` is what makes it read the page the user just arrived at.
   */
  it('moves focus to the heading after a navigation, but not on the first render', async () => {
    const { router } = renderApp({ path: '/dashboard' });
    const heading = await screen.findByRole('heading', { level: 1 });

    expect(document.activeElement).not.toBe(heading);

    await router.navigate({ to: '/login' });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    });
  });
});
