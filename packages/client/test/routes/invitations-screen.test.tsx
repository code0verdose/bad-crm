import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How the invitations screen is reached — criterion 6, and the only part of it a component test
 * cannot see.
 *
 * The screen exists because a link is shown **once**, in the answer to creating an invitation: a
 * person who closed that tab without copying it cannot re-issue or close the invitation, and a
 * second one for the same address is refused `409 invitation_already_exists`. A dead end one click
 * wide. So both screens somebody would look from — the directory of people, and the form itself —
 * carry the way in, and each carries it only for a reader who may use it.
 *
 * `openapi-fetch` captures `globalThis.fetch` when the client module is evaluated, so the stub has
 * to be in place **before** the import — hence `resetModules` and the dynamic import per case.
 */

const platformFetch = globalThis.fetch;

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const DIRECTORY = {
  items: [],
  page: 1,
  perPage: 25,
  total: 0,
  facets: { status: [], role: [], team: [] },
};

let sent: string[];

const startAt = async (path: string, granted: readonly string[]): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('fetch', (input: Request) => {
    const url = new URL(input.url).pathname;

    sent.push(url);

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [...granted], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/invitations')) return json({ items: [] });
    if (url.endsWith('/employees')) return json(DIRECTORY);
    if (url.endsWith('/roles')) return json({ items: [] });
    if (url.endsWith('/teams')) return json({ items: [] });

    return json({ status: 'ok' });
  });

  const { renderApp } = await import('../support/render-app.util.js');

  renderApp({ path, status: 'authenticated' });
};

const invitationsLink = (): HTMLElement | null =>
  screen.queryByRole('link', { name: 'members.invitations.link' });

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe.each([
  ['the directory of people', '/admin/members', 'user:read'],
  ['the invitation form', '/admin/members/invite', 'invitation:create'],
])('%s', (_case, path, entryPermission) => {
  it('offers the way to the open invitations', async () => {
    await startAt(path, [entryPermission, 'invitation:read']);

    await waitFor(() => {
      expect(invitationsLink()).toBeInTheDocument();
    });
    expect(invitationsLink()).toHaveAttribute('href', '/admin/members/invitations');
  });

  it('does not offer it to somebody who may not read invitations', async () => {
    await startAt(path, [entryPermission]);

    // Both preconditions of the absence: the screen itself is on (so the permissions have arrived
    // and the guard let it through), and the link is not there.
    await screen.findByRole('heading', { level: 1 });
    expect(invitationsLink()).toBeNull();
  });
});

describe('walking from the form to the list', () => {
  it('lands on the invitations screen and reads it', async () => {
    const user = userEvent.setup();

    await startAt('/admin/members/invite', ['invitation:create', 'invitation:read']);

    await waitFor(() => {
      expect(invitationsLink()).toBeInTheDocument();
    });

    await user.click(invitationsLink() as HTMLElement);

    expect(await screen.findByTestId('empty-state')).toHaveTextContent('invitations.empty.title');
    expect(sent.some((url) => url.endsWith('/api/v1/invitations'))).toBe(true);
  });
});
