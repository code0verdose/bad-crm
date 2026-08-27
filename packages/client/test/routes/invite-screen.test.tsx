import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

/**
 * `/admin/members/invite` end to end, against a stubbed server.
 *
 * The parts were proved separately — the form and the link panel as components, the policy and the
 * budget on the server. What only shows up here is that they are **wired**: the guard runs before
 * the first frame, the request carries what the person typed, the link that comes back is on the
 * screen, and a caller who cannot read roles is not asked to.
 *
 * `openapi-fetch` captures `globalThis.fetch` when the client module is evaluated, so the stub has
 * to be in place **before** the import — hence `resetModules` and the dynamic import of the render
 * helper in each case.
 */

const ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a91';
const INVITATION = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a92';
const INVITE_URL = 'https://crm.example.test/invite/opaque-token';

const permissions = (granted: readonly string[]): unknown => ({
  permissions: granted,
  denied: [],
  roles: ['admin'],
  isOwner: false,
  version: 1,
});

const roles = {
  items: [
    {
      id: ROLE,
      key: 'tech_writer',
      name: 'Technical writer',
      description: null,
      isSystem: false,
      isDefault: false,
      holderCount: 2,
      permissions: ['task:read'],
    },
  ],
};

let sent: { url: string; method: string; body: unknown }[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stubServer = (
  granted: readonly string[],
  options: { readonly noMail?: boolean } = {},
): void => {
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const body = input.method === 'POST' ? await input.clone().json() : undefined;

    sent.push({ url, method: input.method, body });

    if (url.endsWith('/me/permissions')) return json(permissions(granted));
    if (url.endsWith('/roles')) return json(roles);
    if (url.endsWith('/invitations')) {
      return json(
        {
          id: INVITATION,
          email: (body as { email: string }).email,
          inviteUrl: INVITE_URL,
          expiresAt: '2026-08-14T10:00:00.000Z',
          mailDispatched: options.noMail !== true,
        },
        201,
      );
    }

    return json({ status: 'ok' });
  });
};

const startAt = async (
  granted: readonly string[],
  options: {
    readonly noMail?: boolean;
    /** A real catalogue instead of the suite's `cimode` one — see «in a real language» below. */
    readonly i18n?: I18n;
    readonly language?: string;
  } = {},
): Promise<void> => {
  vi.resetModules();
  stubServer(granted, options);

  const { renderApp } = await import('../support/render-app.util.js');

  renderApp({
    path: '/admin/members/invite',
    status: 'authenticated',
    ...(options.i18n === undefined ? {} : { i18n: options.i18n }),
    ...(options.language === undefined ? {} : { language: options.language }),
  });
};

const INVITER = ['invitation:create', 'role:read'];

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('/admin/members/invite', () => {
  it('refuses somebody who may not invite, and says what they are missing', async () => {
    // Forbidden, not «nothing here»: the section is in everybody's navigation, so naming
    // `invitation:create` leaks nothing and turns the refusal into something an administrator can
    // grant (`ux-architecture.md`, «403 vs 404»).
    await startAt(['task:read']);

    expect(await screen.findByTestId('forbidden-state')).toHaveTextContent('invitation:create');
    expect(screen.queryByText('errors.not_found.title')).not.toBeInTheDocument();
    expect(sent.some((call) => call.method === 'POST')).toBe(false);
  });

  it('sends what the person typed and shows the link that comes back', async () => {
    const user = userEvent.setup();

    await startAt(INVITER);

    await user.type(await screen.findByLabelText(/emailLabel/), 'ivan@example.test');
    await user.click(screen.getByRole('button', { name: /submit/ }));

    await waitFor(() => {
      expect(screen.getByText(INVITE_URL)).toBeInTheDocument();
    });

    const created = sent.find(
      (call) => call.method === 'POST' && call.url.endsWith('/invitations'),
    );

    expect(created?.body).toMatchObject({ email: 'ivan@example.test', roleId: null });
    expect(screen.getByText(/invite\.sent/)).toBeInTheDocument();
  });

  it('warns instead of claiming a letter when the installation has no relay', async () => {
    const user = userEvent.setup();

    await startAt(INVITER, { noMail: true });

    await user.type(await screen.findByLabelText(/emailLabel/), 'ivan@example.test');
    await user.click(screen.getByRole('button', { name: /submit/ }));

    await waitFor(() => {
      expect(screen.getByText(/invite\.noMail/)).toBeInTheDocument();
    });
    expect(screen.getByText(INVITE_URL)).toBeInTheDocument();
  });

  it('says so when the clipboard refuses, because the link is shown only once', async () => {
    // Permission denied, an insecure origin, a browser wanting a fresher gesture — all ordinary, and
    // all silent before: `void … .then(onlySuccess)` dropped the rejection into the global handler.
    // On this screen that is the worst answer available: somebody who believes they copied the link
    // and did not has lost the only copy of it.
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));

    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    await startAt(INVITER);

    await user.type(await screen.findByLabelText(/emailLabel/), 'ivan@example.test');
    await user.click(screen.getByRole('button', { name: /submit/ }));

    await waitFor(() => {
      expect(screen.getByText(INVITE_URL)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /invite\.copy/ }));

    expect(await screen.findByText(/invite\.copyFailed/)).toBeInTheDocument();
    // And the link is still on screen to be selected by hand.
    expect(screen.getByText(INVITE_URL)).toBeInTheDocument();
  });

  it('sends the chosen role, and copies the link when asked', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());

    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    await startAt(INVITER);

    await user.type(await screen.findByLabelText(/emailLabel/), 'ivan@example.test');
    await waitFor(() => {
      expect(sent.some((call) => call.url.endsWith('/roles'))).toBe(true);
    });
    // A native `<select>`, so the choice is made the way a browser makes it — and by label, because
    // the application shell has a control of its own that an index into every combobox would hit.
    await user.selectOptions(screen.getByLabelText(/invite\.roleLabel/), ROLE);
    await user.click(screen.getByRole('button', { name: /submit/ }));

    await waitFor(() => {
      expect(screen.getByText(INVITE_URL)).toBeInTheDocument();
    });

    const created = sent.find(
      (call) => call.method === 'POST' && call.url.endsWith('/invitations'),
    );

    expect(created?.body).toMatchObject({ roleId: ROLE });

    await user.click(screen.getByRole('button', { name: /invite\.copy/ }));

    // The link the response carried, not text scraped back out of the DOM.
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(INVITE_URL);
    });
  });

  it('does not ask for roles when the caller may not read them', async () => {
    await startAt(['invitation:create']);

    await screen.findByLabelText(/emailLabel/);

    // Inviting and reading roles are two capabilities. Asking anyway would put a 403 on a screen
    // that is working exactly as intended; the select simply offers «no role for now».
    expect(sent.some((call) => call.url.endsWith('/roles'))).toBe(false);
  });
});

/**
 * The property `cimode` cannot state, about the one signal that matters most on this screen.
 *
 * Every assertion above matches a **key**, and under `cimode` `t(key)` returns the key — so a
 * notification whose text never went through `t()` at all is indistinguishable from one that did,
 * and `invite.copyFailed` matches either way. That is tolerable for a heading. It is not tolerable
 * here: this sentence is what tells somebody that the link they think they copied is **not** in
 * their clipboard, and the link is shown once. A key on screen instead of a sentence would be, to
 * the person reading it, the same silence the handler exists to prevent.
 *
 * So the catalogue is rendered for real, in both languages, and two things are asserted: the
 * sentence a person has to be able to read, and that no raw key reached the screen beside it.
 * The second is what makes the first discriminating — a missing `t()` renders the key, and the key
 * is exactly what the second assertion forbids.
 */
describe.each(['en', 'ru'] as const)(
  'a refused clipboard on the invite screen in %s',
  (language) => {
    it('says in words that the link was not copied', async () => {
      const user = userEvent.setup();
      const i18n = SharedI18n.createI18n(language);
      const writeText = vi.fn(() => Promise.reject(new Error('denied')));

      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

      await startAt(INVITER, { i18n, language });

      // By role rather than by label: Mantine appends a required marker to the label text, and the
      // address field is called «E-mail» in both catalogues anyway — it proves nothing about language.
      // The two controls that do are named through the catalogue below.
      await user.type(await screen.findByRole('textbox'), 'ivan@example.test');
      await user.click(screen.getByRole('button', { name: i18n.t('members.invite.submit') }));

      await waitFor(() => {
        expect(screen.getByText(INVITE_URL)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: i18n.t('members.invite.copy') }));

      expect(await screen.findByText(i18n.t('members.invite.copyFailed'))).toBeInTheDocument();
      // No raw key anywhere on the screen: `t()` returns the key itself when the sentence never went
      // through it, which is the one failure a `cimode` suite can never see.
      expect(screen.queryByText(/members\.invite\./)).toBeNull();
      // And the link is still there to be selected by hand — the point of saying so at all.
      expect(screen.getByText(INVITE_URL)).toBeInTheDocument();
    });
  },
);
