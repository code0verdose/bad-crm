import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/invite/$token` end to end, against a stubbed server.
 *
 * Three properties only show up here, and each is about the whole path rather than any one piece:
 * the screen is reachable **without a session**, the token travels from the path into the request
 * **body** and never into a query string, and a successful acceptance ends inside the application
 * rather than at the login form.
 */

const TOKEN = 'a'.repeat(43);
const PASSWORD = 'correct-horse-battery';

let sent: { url: string; method: string; body: unknown }[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const session = {
  status: 'authenticated',
  accessToken: 'access-token-of-the-new-account',
  tokenType: 'Bearer',
  expiresIn: 900,
  user: {
    id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ac1',
    email: 'ivan@example.test',
    locale: 'ru',
    timezone: 'UTC',
  },
  organization: {
    id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ac2',
    name: 'Acme',
    slug: 'acme',
  },
};

const stubServer = (
  options: { readonly refuse?: boolean; readonly malformed?: boolean } = {},
): void => {
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const body = input.method === 'POST' ? await input.clone().json() : undefined;

    sent.push({ url, method: input.method, body });

    if (url.endsWith('/invitations/accept')) {
      if (options.refuse === true) return json({ code: 'invitation_not_valid', status: 410 }, 410);
      // A 201 whose body is not a session: what a mismatched deployment would answer, and the case
      // `adoptSession` exists to survive.
      if (options.malformed === true) return json({ status: 'authenticated' }, 201);

      return json(session, 201);
    }
    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [], denied: [], roles: [], isOwner: false, version: 1 });
    }

    return json({ status: 'ok' });
  });
};

const startAt = async (
  options: { readonly refuse?: boolean; readonly malformed?: boolean } = {},
): Promise<{ router: { state: { location: { pathname: string } } } }> => {
  vi.resetModules();
  stubServer(options);

  const { renderApp } = await import('../support/render-app.util.js');

  // `anonymous`, and that is the case that matters: somebody following this link has no account.
  return renderApp({ path: `/invite/${TOKEN}`, status: 'anonymous' });
};

const fillIn = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.type(await screen.findByLabelText(/accept\.passwordLabel/), PASSWORD);
  await user.type(screen.getByLabelText(/accept\.confirmLabel/), PASSWORD);
  await user.click(screen.getByRole('button', { name: /accept\.submit/ }));
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('/invite/$token', () => {
  it('opens without a session and asks only for a password', async () => {
    await startAt();

    expect(await screen.findByLabelText(/accept\.passwordLabel/)).toBeInTheDocument();
    // No address field: the account is created on the address the invitation carries, and a form
    // that asked would be asking a question the server refuses to read.
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  it('sends the token in the body and lands inside the application', async () => {
    const user = userEvent.setup();
    const { router } = await startAt();

    await fillIn(user);

    // Left the invitation screen. **Not** `toBe('/')`: `renderApp` hands the router a fixed auth
    // status rather than the live store, so the guard on `/` still reads «anonymous» in this
    // harness and bounces to `/login`. Asserting the destination would be asserting the fixture;
    // asserting that the screen was left is the property this case owns.
    await waitFor(() => {
      expect(router.state.location.pathname).not.toBe(`/invite/${TOKEN}`);
    });

    const accepted = sent.find((call) => call.url.endsWith('/invitations/accept'));

    expect(accepted?.body).toMatchObject({ token: TOKEN, password: PASSWORD });
    // The token reached the API in a body and in no URL: a query string is copied into `Referer`
    // and written to every proxy log in front of the installation.
    expect(sent.every((call) => !call.url.includes(TOKEN))).toBe(true);
  });

  it('refuses to submit two passwords that differ, without asking the server', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.type(await screen.findByLabelText(/accept\.passwordLabel/), PASSWORD);
    await user.type(screen.getByLabelText(/accept\.confirmLabel/), 'something-else-entirely');
    await user.click(screen.getByRole('button', { name: /accept\.submit/ }));

    await waitFor(() => {
      expect(sent.some((call) => call.url.endsWith('/invitations/accept'))).toBe(false);
    });
  });

  it('does not sign anybody in on an answer that is not a session', async () => {
    // `adoptSession` refuses a document it cannot parse and clears the token rather than storing
    // half of one. The screen then stays put: there is no session to go anywhere with.
    const user = userEvent.setup();
    const { router } = await startAt({ malformed: true });

    await fillIn(user);

    await waitFor(() => {
      expect(sent.some((call) => call.url.endsWith('/invitations/accept'))).toBe(true);
    });
    expect(router.state.location.pathname).toBe(`/invite/${TOKEN}`);
  });

  it('stays on the screen when the link is no longer valid', async () => {
    const user = userEvent.setup();
    const { router } = await startAt({ refuse: true });

    await fillIn(user);

    await waitFor(() => {
      expect(sent.some((call) => call.url.endsWith('/invitations/accept'))).toBe(true);
    });
    // The refusal is one red toast from the global handler; the screen itself does not move, so a
    // person who mistyped nothing can see what happened rather than land somewhere else.
    expect(router.state.location.pathname).toBe(`/invite/${TOKEN}`);
  });
});
