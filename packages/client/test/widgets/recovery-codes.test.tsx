import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * What is left of the way back in, on `/settings/security`, once 2FA is on.
 *
 * The properties:
 *
 *   * **the count is readable as a fraction.** «3» says nothing; «3 of 10» is the whole content of
 *     the warning under it;
 *   * **the warning is permanent and changes at zero.** «Running out» and «there is no way back
 *     except the app» are different situations, and softening the second into «you have 0 codes»
 *     leaves somebody believing there is still a list to find;
 *   * **replacing asks for both proofs.** The set being destroyed is the way back into the account;
 *   * **a fresh set is shown once, and cannot be closed past.** Overlay, `Escape` and both close
 *     controls are inert until the person says they have the codes — the only screen in the product
 *     where closing a window destroys something irreplaceable;
 *   * **the codes leave by the door they came in.** A file and a printout, then nothing: not in
 *     storage, not in the address bar, not in a request.
 */

const PASSWORD = 'correct horse battery staple';
const CODES = [
  '23456ABCDE',
  'FGHJKMNPQR',
  'STUVWXYZ23',
  '456789ABCD',
  'EFGHJKMNPQ',
  'RSTUVWXYZ2',
  '3456789ABC',
  'DEFGHJKMNP',
  'QRSTUVWXYZ',
  '23456789AB',
] as const;

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let sent: Call[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const problem = (code: string, status: number): Response =>
  new Response(
    JSON.stringify({
      type: `https://bad-crm.dev/problems/${code}`,
      title: code,
      status,
      code,
      requestId: 'req-1',
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

interface Answers {
  /** Evaluated per request, so a reissue can answer differently from the read before it. */
  readonly counts?: () => Response;
  readonly regenerate?: () => Response;
}

const startAt = async ({
  counts = () => json({ total: 10, remaining: 7 }),
  regenerate = () => json({ codes: [...CODES] }),
}: Answers = {}): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const raw = input.method === 'POST' ? await input.clone().text() : '';
    const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);

    sent.push({ url, method: input.method, body });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/2fa/recovery-codes/regenerate')) return regenerate();
    if (url.endsWith('/2fa/recovery-codes')) return counts();

    return json({ status: 'ok' });
  });

  const { renderApp } = await import('../support/render-app.util.js');

  renderApp({ path: '/settings/security', status: 'authenticated' });
};

const callsTo = (suffix: string, method: string): Call[] =>
  sent.filter((call) => call.url.endsWith(suffix) && call.method === method);

const submitReissue = async (user: UserEvent, code: string = '123456'): Promise<void> => {
  await user.type(screen.getByLabelText(/security\.codes\.regenerate\.password\.label/), PASSWORD);
  await user.type(screen.getByLabelText(/security\.codes\.regenerate\.code\.label/), code);
  await user.click(screen.getByRole('button', { name: /security\.codes\.regenerate\.submit/ }));
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the counter', () => {
  it('says how many are unused out of how many were issued', async () => {
    await startAt();

    expect(await screen.findByText(/security\.codes\.remaining/)).toBeInTheDocument();
    // Nothing is wrong yet, so nothing warns: a banner that is always there is a banner nobody sees.
    expect(screen.queryByText(/security\.codes\.low\.title/)).toBeNull();
    expect(screen.queryByText(/security\.codes\.none\.title/)).toBeNull();
  });

  it('warns permanently once three or fewer are unused', async () => {
    await startAt({ counts: () => json({ total: 10, remaining: 3 }) });

    expect(await screen.findByText(/security\.codes\.low\.title/)).toBeInTheDocument();
    expect(screen.getByText(/security\.codes\.low\.description/)).toBeInTheDocument();
    expect(screen.queryByText(/security\.codes\.none\.title/)).toBeNull();
  });

  /**
   * Four is not «running out», and the boundary is the assertion — a warning that starts one code
   * too early is noise, one code too late is a person locked out.
   */
  it('does not warn at four', async () => {
    await startAt({ counts: () => json({ total: 10, remaining: 4 }) });

    expect(await screen.findByText(/security\.codes\.remaining/)).toBeInTheDocument();
    expect(screen.queryByText(/security\.codes\.low\.title/)).toBeNull();
  });

  it('says something else entirely when none are left', async () => {
    await startAt({ counts: () => json({ total: 10, remaining: 0 }) });

    expect(await screen.findByText(/security\.codes\.none\.title/)).toBeInTheDocument();
    expect(screen.getByText(/security\.codes\.none\.description/)).toBeInTheDocument();
    // Not «0 codes left» in the same sentence as «replace them soon»: at zero the app is the only
    // way in, and the screen has to say that rather than count down to it.
    expect(screen.queryByText(/security\.codes\.low\.description/)).toBeNull();
  });

  it('offers a way back from a failure, and the way back works', async () => {
    const user = userEvent.setup();
    // A flag rather than a request counter: the query retries once by default and `StrictMode`
    // mounts twice, so «fail the first attempt» would have been repaired by the suite itself.
    let recovers = false;

    await startAt({
      counts: () => (recovers ? json({ total: 10, remaining: 7 }) : problem('internal_error', 500)),
    });

    expect(await screen.findByTestId('error-state')).toBeInTheDocument();
    // The form is not offered over a screen that failed to load: it would ask for a code against a
    // set nobody knows the size of.
    expect(
      screen.queryByRole('button', { name: /security\.codes\.regenerate\.submit/ }),
    ).toBeNull();

    // CONTROL: the retry is a working control rather than a decoration on an error state — the same
    // screen, the same mount, and only the answer changed.
    recovers = true;
    await user.click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByText(/security\.codes\.remaining/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /security\.codes\.regenerate\.submit/ }),
    ).toBeInTheDocument();
  });
});

describe('replacing the set', () => {
  it('asks for both proofs before it sends anything', async () => {
    const user = userEvent.setup();

    await startAt();
    await screen.findByText(/security\.codes\.remaining/);

    await user.click(screen.getByRole('button', { name: /security\.codes\.regenerate\.submit/ }));

    expect(await screen.findByText(/validation\.password\.required/)).toBeInTheDocument();
    expect(screen.getByText(/validation\.totp_code\.invalid/)).toBeInTheDocument();
    expect(callsTo('/2fa/recovery-codes/regenerate', 'POST')).toEqual([]);
  });

  it('sends the password and the code together', async () => {
    const user = userEvent.setup();

    await startAt();
    await screen.findByText(/security\.codes\.remaining/);
    await submitReissue(user);

    await waitFor(() => {
      expect(callsTo('/2fa/recovery-codes/regenerate', 'POST')).toHaveLength(1);
    });
    expect(callsTo('/2fa/recovery-codes/regenerate', 'POST')[0]?.body).toEqual({
      currentPassword: PASSWORD,
      totpCode: '123456',
    });
  });

  /**
   * The refusal sits above both fields rather than under either.
   *
   * `403 reauthentication_required` answers a wrong password, a wrong code and «this account has no
   * TOTP» alike — the server evaluates both proofs whatever the first one says. Attaching the
   * message to a field would claim knowledge the server deliberately refused to give.
   */
  it('shows a refusal beside the form, exactly once', async () => {
    const user = userEvent.setup();

    await startAt({ regenerate: () => problem('reauthentication_required', 403) });
    await screen.findByText(/security\.codes\.remaining/);
    await submitReissue(user);

    expect(
      await screen.findByText(/security\.codes\.regenerate\.failed\.title/),
    ).toBeInTheDocument();
    // One action, one signal: the mutation owns its failure, so the global toast stands aside.
    expect(screen.getAllByText(/errors\.code\.reauthentication_required/)).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /**
   * The side effect, asserted as a second request rather than as a callback that ran.
   *
   * The counter on screen — «7 of 10», the reason somebody pressed this button — is wrong by ten the
   * moment the answer arrives. A spy on `onSuccess` would be equally happy with an invalidation
   * aimed at a key nothing reads.
   */
  it('asks the server again for the counter it has just replaced', async () => {
    const user = userEvent.setup();

    await startAt();
    await screen.findByText(/security\.codes\.remaining/);

    const before = callsTo('/2fa/recovery-codes', 'GET').length;

    await submitReissue(user);
    await screen.findByRole('dialog');

    await waitFor(() => {
      expect(callsTo('/2fa/recovery-codes', 'GET').length).toBeGreaterThan(before);
    });
  });
});

describe('the fresh set on screen', () => {
  const reissue = async (user: UserEvent): Promise<HTMLElement> => {
    await startAt();
    await screen.findByText(/security\.codes\.remaining/);
    await submitReissue(user);

    return await screen.findByRole('dialog');
  };

  it('shows all ten and says they will not be shown again', async () => {
    const user = userEvent.setup();
    const dialog = within(await reissue(user));

    for (const code of CODES) expect(dialog.getByText(code)).toBeInTheDocument();
    expect(dialog.getByText(/security\.codes\.dialog\.onceTitle/)).toBeInTheDocument();
  });

  it('keeps the focus inside itself', async () => {
    const user = userEvent.setup();
    const dialog = await reissue(user);

    for (let step = 0; step < 12; step += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('cannot be dismissed by Escape, or by either close control, until they are saved', async () => {
    const user = userEvent.setup();
    const dialog = await reissue(user);

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBe(dialog);

    expect(
      within(dialog).getByRole('button', { name: /security\.codes\.dialog\.close/ }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: /security\.codes\.dialog\.done/ }),
    ).toBeDisabled();
  });

  /**
   * And it *can* be dismissed once they are, which is what keeps «cannot be closed» from being a
   * keyboard trap: the way out is inside the dialog, reachable by Tab and operable with Space.
   *
   * Focus lands on the page's `h1` rather than on the button that opened the dialog, and that is a
   * decision rather than a shortcut — the component says why at length. In short: the button is
   * `loading` when the dialog opens, so a browser has already taken focus off it, and after an
   * *enrolment* it does not exist by the time the dialog closes. The heading is where the route
   * announcer sends focus when what a page is about changes, and it has just changed.
   */
  it('closes once the box is ticked, and puts focus back on the page it changed', async () => {
    const user = userEvent.setup();
    const dialog = await reissue(user);

    await user.click(within(dialog).getByLabelText(/security\.codes\.dialog\.saved/));
    await user.click(within(dialog).getByRole('button', { name: /security\.codes\.dialog\.done/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    });
    // CONTROL: nowhere is the failure this replaces — focus on `<body>`, which is what a return to a
    // detached or disabled trigger actually produces.
    expect(document.activeElement).not.toBe(document.body);
  });

  it('takes the codes with it when it goes', async () => {
    const user = userEvent.setup();
    const dialog = await reissue(user);

    await user.click(within(dialog).getByLabelText(/security\.codes\.dialog\.saved/));
    await user.click(within(dialog).getByRole('button', { name: /security\.codes\.dialog\.done/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    for (const code of CODES) expect(screen.queryByText(code)).toBeNull();
  });

  /**
   * A second reissue starts from an unticked box.
   *
   * The confirmation is state inside a component that only exists while a set does — so this is
   * asserting the lifetime, not the checkbox: a dialog whose «I have saved them» survived into the
   * *next* set would be a set of ten codes one click away from being destroyed unread.
   */
  it('starts the next set from an unticked box', async () => {
    const user = userEvent.setup();
    const first = await reissue(user);

    await user.click(within(first).getByLabelText(/security\.codes\.dialog\.saved/));
    await user.click(within(first).getByRole('button', { name: /security\.codes\.dialog\.done/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await submitReissue(user);

    const second = within(await screen.findByRole('dialog'));

    expect(second.getByLabelText(/security\.codes\.dialog\.saved/)).not.toBeChecked();
    expect(second.getByRole('button', { name: /security\.codes\.dialog\.done/ })).toBeDisabled();
  });

  it('never lets the codes reach storage, the address bar or a later request', async () => {
    const user = userEvent.setup();

    await reissue(user);

    const stored = JSON.stringify({ ...globalThis.localStorage, ...globalThis.sessionStorage });
    const sentBodies = JSON.stringify(sent.map((call) => ({ url: call.url, body: call.body })));

    for (const code of CODES) {
      expect(stored).not.toContain(code);
      expect(globalThis.location.href).not.toContain(code);
      expect(sentBodies).not.toContain(code);
    }
  });
});

describe('taking the codes away from the screen', () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:bad-crm/recovery');
  const revokeObjectURL = vi.fn<(url: string) => void>(() => undefined);
  const platform = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const print = vi.fn();

  let downloaded: { href: string | null; name: string; blob: Blob | undefined } | undefined;

  beforeAll(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.stubGlobal('print', print);

    // Intercepted rather than allowed through: jsdom implements no downloads, so a real click would
    // be a *navigation* — the exact behaviour the download exists to avoid, and therefore the one
    // outcome this must not be unable to tell apart from success.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      const anchor = document.querySelector<HTMLAnchorElement>('a[download]');

      downloaded = {
        href: anchor?.getAttribute('href') ?? null,
        name: anchor?.download ?? '',
        blob: createObjectURL.mock.calls.at(-1)?.[0],
      };
    });
  });

  afterAll(() => {
    URL.createObjectURL = platform.create;
    URL.revokeObjectURL = platform.revoke;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    downloaded = undefined;
    print.mockClear();
    revokeObjectURL.mockClear();
  });

  const openSet = async (user: UserEvent): Promise<HTMLElement> => {
    await startAt();
    await screen.findByText(/security\.codes\.remaining/);
    await submitReissue(user);

    return await screen.findByRole('dialog');
  };

  it('offers a file that contains every code, and navigates nowhere to deliver it', async () => {
    const user = userEvent.setup();
    const dialog = await openSet(user);
    const before = globalThis.location.href;

    await user.click(
      within(dialog).getByRole('button', { name: /security\.codes\.dialog\.download/ }),
    );

    expect(downloaded?.name).toBe('bad-crm-recovery-codes.txt');
    expect(await downloaded?.blob?.text()).toContain(CODES[0]);
    expect(await downloaded?.blob?.text()).toContain(CODES.at(-1));

    // An opaque handle, dropped straight afterwards — never a `data:` URL carrying the codes, and
    // never a navigation that would put them in the session history.
    expect(downloaded?.href).toBe('blob:bad-crm/recovery');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:bad-crm/recovery');
    expect(globalThis.location.href).toBe(before);
  });

  it('asks the browser to print, with the codes marked as the only thing worth ink', async () => {
    const user = userEvent.setup();
    const dialog = await openSet(user);

    await user.click(
      within(dialog).getByRole('button', { name: /security\.codes\.dialog\.print/ }),
    );

    expect(print).toHaveBeenCalledTimes(1);

    // The premise of the print stylesheet in `app/global.css`, which jsdom cannot evaluate: the list
    // carries the marker the rule selects on, and the controls carry the one it hides.
    const list = within(dialog).getByRole('list', { name: /security\.codes\.list\.aria/ });

    expect(list).toHaveAttribute('data-bc-print');
    expect(dialog.querySelectorAll('[data-bc-print-hidden]').length).toBeGreaterThan(0);
  });
});

describe('accessibility of every state of the recovery-code screen', () => {
  it('has no violation while the count is normal', async () => {
    await startAt();
    await screen.findByText(/security\.codes\.remaining/);

    expect(await axeViolationsIn(document.body, { control: 'button-name' })).toEqual([]);
  });

  it('has no violation while the warning is on screen', async () => {
    await startAt({ counts: () => json({ total: 10, remaining: 1 }) });
    await screen.findByText(/security\.codes\.low\.title/);

    expect(await axeViolationsIn(document.body, { control: 'button-name' })).toEqual([]);
  });

  it('has no violation while none are left', async () => {
    await startAt({ counts: () => json({ total: 10, remaining: 0 }) });
    await screen.findByText(/security\.codes\.none\.title/);

    expect(await axeViolationsIn(document.body, { control: 'button-name' })).toEqual([]);
  });

  it('has no violation while a fresh set is on screen', async () => {
    const user = userEvent.setup();

    await startAt();
    await screen.findByText(/security\.codes\.remaining/);
    await submitReissue(user);

    expect(
      await axeViolationsIn(await screen.findByRole('dialog'), {
        modal: true,
        // `aria-allowed-attr` rather than `button-name`: the list of codes is what this state adds,
        // and its accessible name is the thing a scan of the wrong subtree would miss.
        control: 'aria-allowed-attr',
      }),
    ).toEqual([]);
  });
});
