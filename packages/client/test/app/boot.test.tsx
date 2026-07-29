import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The entry point, from `index.html` down.
 *
 * What is under test is `main.tsx` itself — the file every other suite would otherwise leave
 * uncovered while the page stays blank in a browser: the policies it installs before the first
 * render, the node it mounts into, and its refusal to start when that node is missing. Where the
 * first navigation ends up once a session exists is `test/app/session-bootstrap.test.tsx`.
 *
 * The transport is stubbed with a live session, because the entry point now starts one: the
 * bootstrap exchange runs on the first render, and a suite that let it reach the real `fetch` would
 * be a suite that depends on a server.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const authenticated = (): Response =>
  new Response(
    JSON.stringify({
      status: 'authenticated',
      accessToken: 'access-token-1',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
      organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/**
 * Restored rather than unstubbed: `vi.unstubAllGlobals()` would also remove `matchMedia`,
 * `scrollTo` and `ResizeObserver`, the three platform APIs `test/setup` supplies because jsdom does
 * not.
 */
const platformFetch = globalThis.fetch;

describe('the entry point', () => {
  beforeEach(() => {
    // The entry module runs its work at import time, so each case needs a fresh evaluation.
    vi.resetModules();
    vi.stubGlobal('fetch', () => Promise.resolve(authenticated()));
    document.body.innerHTML = '';
    window.history.pushState({}, '', '/');
  });

  afterEach(() => {
    vi.stubGlobal('fetch', platformFetch);
  });

  it('mounts into #root and renders the shell around the first screen', async () => {
    document.body.innerHTML = '<div id="root"></div>';

    await import('@app/main.js');

    // `createRoot(...).render(...)` schedules the first paint, so the assertion waits for the tree.
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('nav.dashboard');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
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
