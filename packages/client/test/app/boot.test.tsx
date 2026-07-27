import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@app';
import { SESSION_STATUS_LABEL_KEY } from '@units/session/model';

/**
 * The shell, from the entry point down.
 *
 * Two things are under test and neither is a component: that the layers are wired to each other
 * (`app → pages → widgets → units`), and that `main.tsx` really mounts — the file every other test
 * would otherwise leave uncovered while the page stays blank in a browser.
 */
describe('application shell', () => {
  beforeEach(() => {
    // The entry module runs its work at import time, so each case needs a fresh evaluation.
    vi.resetModules();
    document.body.innerHTML = '';
  });

  it('renders the page heading and the session state the unit reports', () => {
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Bad CRM');
    expect(screen.getByText(SESSION_STATUS_LABEL_KEY.unknown)).toBeInTheDocument();
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
