import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@app';

/**
 * The shell, from the entry point down.
 *
 * Two things are under test and neither is a component: that the layers are wired to each other
 * (`app → pages → widgets → units`, now through the router), and that `main.tsx` really mounts —
 * the file every other test would otherwise leave uncovered while the page stays blank in a
 * browser.
 *
 * The history starts at `/`, so a passing assertion proves the whole first navigation: the guard on
 * `_authenticated` let an unknown session through, the index route redirected to `/dashboard`, the
 * shell mounted, and the page rendered inside it.
 */
describe('application shell', () => {
  beforeEach(() => {
    // The entry module runs its work at import time, so each case needs a fresh evaluation.
    vi.resetModules();
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/');
  });

  it('lands on the dashboard and renders it inside the shell', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('nav.dashboard');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('mounts into #root when the entry module is loaded', async () => {
    document.body.innerHTML = '<div id="root"></div>';

    await import('@app/main.js');

    // `createRoot(...).render(...)` schedules the first paint, so the assertion waits for the tree.
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  /**
   * The failure that would otherwise be a blank page and an empty console: an `index.html` whose
   * mount node was renamed, or a bundle loaded into a document that has none.
   */
  it('refuses to start when the mount node is missing instead of rendering nowhere', async () => {
    document.body.innerHTML = '<div id="not-root"></div>';

    await expect(import('@app/main.js')).rejects.toThrow(/#root/);
  });
});
