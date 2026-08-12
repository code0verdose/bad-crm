import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { createTrustedHtml } from '@app/trusted-types.util.js';
import { SharedI18n } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * Turning on the second factor, from `/settings/security`.
 *
 * The properties, and the reason each of them is a property rather than a detail:
 *
 *   * **the consequences are on screen before the button that causes them.** Enabling cannot be
 *     undone on this build — disabling and administrator reset are STORY-013-04 — so the three
 *     sentences that say so are part of the control, not documentation of it;
 *   * **the secret is legible without a camera.** A QR code is a picture; a desktop browser cannot
 *     photograph its own screen, a hardware token has no camera, and a screen reader cannot read
 *     one. The base32 string beside it is the same secret, and it is what makes the screen usable;
 *   * **the confirmation carries the password.** A session alone must not be able to attach a second
 *     factor — the contract changed to require it, and this is the client half of that change;
 *   * **a refused confirmation says where to go.** The ten recovery codes travel in the answer to
 *     this one request and exist nowhere else; a lost answer leaves 2FA on and the codes unseen,
 *     and the screen has to name the way out rather than say «wrong code»;
 *   * **what was shown is shown once.** The secret and the codes live on the screen and in nothing
 *     that survives it — no storage, no URL, no request.
 */

const SECRET = 'JBSWY3DPEHPK3PXP';
const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
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
/** What the counter answers — flipped by a successful confirmation, exactly as the server does. */
let enrolled: boolean;

const platformFetch = globalThis.fetch;

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** `application/problem+json` as the server produces it — `code` is the only field the UI reads. */
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
  readonly setup?: () => Response;
  readonly confirm?: () => Response;
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({
  setup = () =>
    json({ secret: SECRET, uri: `otpauth://totp/BadCRM?secret=${SECRET}`, qrSvg: QR_SVG }),
  confirm = () => {
    enrolled = true;

    return json({ codes: [...CODES] });
  },
  i18n,
  language,
}: Answers = {}): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    // `text()` and then parse, rather than `json()`: `POST /auth/2fa/setup` carries no body at all,
    // and `json()` on an empty one rejects — which would make every enrolment fail here for a
    // reason that has nothing to do with the screen.
    const raw = input.method === 'POST' ? await input.clone().text() : '';
    const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);

    sent.push({ url, method: input.method, body });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/2fa/setup')) return setup();
    if (url.endsWith('/2fa/confirm')) return confirm();
    if (url.endsWith('/2fa/recovery-codes')) {
      return json(enrolled ? { total: 10, remaining: 10 } : { total: 0, remaining: 0 });
    }

    return json({ status: 'ok' });
  });

  const { renderApp } = await import('../support/render-app.util.js');

  renderApp({
    path: '/settings/security',
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });
};

const callsTo = (suffix: string, method: string): Call[] =>
  sent.filter((call) => call.url.endsWith(suffix) && call.method === method);

/** Presses «Enable» and waits for the drafted secret to be on screen. */
const beginEnrolment = async (user: UserEvent): Promise<void> => {
  await user.click(await screen.findByRole('button', { name: /security\.totp\.enable/ }));
  await screen.findByText(SECRET);
};

const fillConfirmation = async (user: UserEvent, code: string = '123456'): Promise<void> => {
  await user.type(screen.getByLabelText(/security\.totp\.code\.label/), code);
  await user.type(screen.getByLabelText(/security\.totp\.password\.label/), PASSWORD);
  await user.click(screen.getByRole('button', { name: /security\.totp\.confirm/ }));
};

beforeEach(() => {
  sent = [];
  enrolled = false;
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the enrolment screen before anything is drafted', () => {
  it('states all three consequences of enabling, above the button that does it', async () => {
    await startAt();

    const button = await screen.findByRole('button', { name: /security\.totp\.enable/ });

    // Every one of the three, named individually: this is the set of things a person cannot find
    // out afterwards, and «two of the three» is the failure this case exists to catch.
    expect(screen.getByText(/security\.totp\.warning\.noDisable/)).toBeInTheDocument();
    expect(screen.getByText(/security\.totp\.warning\.recoveryOnly/)).toBeInTheDocument();
    expect(screen.getByText(/security\.totp\.warning\.lostAnswer/)).toBeInTheDocument();

    // Above it in the document, not merely somewhere on the page: a warning under the button is a
    // warning read after the decision.
    expect(
      screen.getByText(/security\.totp\.warning\.noDisable/).compareDocumentPosition(button) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('asks for nothing until the button is pressed', async () => {
    await startAt();

    await screen.findByRole('button', { name: /security\.totp\.enable/ });

    // CONTROL: the screen did ask for the one thing it reads, so «no setup request» is about the
    // secret and not about a screen that never mounted.
    expect(callsTo('/2fa/recovery-codes', 'GET').length).toBeGreaterThan(0);
    expect(callsTo('/2fa/setup', 'POST')).toEqual([]);
  });
});

describe('the drafted secret', () => {
  it('is shown as a picture and as text, because a camera is not always there', async () => {
    const user = userEvent.setup();

    await startAt();
    await beginEnrolment(user);

    const qr = screen.getByRole('img', { name: /security\.totp\.qr\.alt/ });

    expect(qr).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml,'));
    // The string itself, in a text node — not merely inside the picture's source, which is what a
    // reader without sight and a browser without a camera both need.
    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  /**
   * Why the QR is an `<img>` and not the SVG document the server sent.
   *
   * The direct route is `dangerouslySetInnerHTML`, and this application runs under
   * `require-trusted-types-for 'script'` with a single `default` policy that refuses any string
   * containing an angle bracket (ADR-0023). In a browser that route throws and the enrolment screen
   * is blank; in jsdom, which has no Trusted Types, it would pass every test. So the refusal is
   * exercised against the real policy, next to the assertion that the working route is used.
   */
  it('could not have been rendered as markup: the HTML sink refuses it', () => {
    expect(() => createTrustedHtml(QR_SVG)).toThrow(TypeError);
  });

  it('is typed as a one-time code, so a phone offers it and shows digits', async () => {
    const user = userEvent.setup();

    await startAt();
    await beginEnrolment(user);

    const code = screen.getByLabelText(/security\.totp\.code\.label/);

    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    // `text`, not `number`: a number input drops the leading zero of `012345`, which is a code.
    expect(code).toHaveAttribute('type', 'text');
    expect(code).toHaveAttribute('maxlength', '6');
  });

  it('is thrown away, not merely hidden, when the enrolment is abandoned', async () => {
    const user = userEvent.setup();

    await startAt();
    await beginEnrolment(user);

    await user.click(screen.getByRole('button', { name: /security\.totp\.cancel/ }));

    expect(
      await screen.findByRole('button', { name: /security\.totp\.enable/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).toBeNull();
  });
});

describe('confirming the enrolment', () => {
  it('sends the code and the current password together', async () => {
    const user = userEvent.setup();

    await startAt();
    await beginEnrolment(user);
    await fillConfirmation(user);

    await waitFor(() => {
      expect(callsTo('/2fa/confirm', 'POST')).toHaveLength(1);
    });

    // Both fields, and nothing else: the contract is `additionalProperties: false`, and the
    // password is what stops a stolen session from attaching somebody else's authenticator.
    expect(callsTo('/2fa/confirm', 'POST')[0]?.body).toEqual({
      code: '123456',
      currentPassword: PASSWORD,
    });
  });

  it('refuses to send a code that is not six digits, and says so under the field', async () => {
    const user = userEvent.setup();

    await startAt();
    await beginEnrolment(user);
    await fillConfirmation(user, '12');

    expect(await screen.findByText(/validation\.totp_code\.invalid/)).toBeInTheDocument();
    // Nothing left the browser: a badly formed code is decidable here, and spending a request on it
    // would also spend one of five attempts in the server's fifteen-minute budget.
    expect(callsTo('/2fa/confirm', 'POST')).toEqual([]);
    // Inline, at the field — never a toast (`rules/errors-and-toasts.mdc` §4).
    expect(screen.getByLabelText(/security\.totp\.code\.label/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('shows a refusal beside the fields, exactly once, and names the way out', async () => {
    const user = userEvent.setup();

    await startAt({ confirm: () => problem('invalid_totp_code', 422) });
    await beginEnrolment(user);
    await fillConfirmation(user);

    expect(await screen.findByText(/security\.totp\.failed\.title/)).toBeInTheDocument();
    // One action, one signal: the mutation declares its own `onError`, so the global toast stands
    // aside instead of adding a second copy of the same sentence.
    expect(screen.getAllByText(/errors\.code\.invalid_totp_code/)).toHaveLength(1);
    // The half that matters more than the refusal itself: «this may already have worked, and here
    // is where to get a set of codes».
    expect(screen.getByText(/security\.totp\.failed\.lostAnswer/)).toBeInTheDocument();
  });

  /**
   * A code that was already accepted is not a wrong code.
   *
   * The server tells them apart on purpose — `422 totp_code_replayed` against `422
   * invalid_totp_code` — because the advice differs: wait for the next code, rather than go looking
   * for a typo in one that was right.
   */
  it('tells a replayed code apart from a wrong one', async () => {
    const user = userEvent.setup();

    await startAt({ confirm: () => problem('totp_code_replayed', 422) });
    await beginEnrolment(user);
    await fillConfirmation(user);

    expect(await screen.findByText(/errors\.code\.totp_code_replayed/)).toBeInTheDocument();
    expect(screen.queryByText(/errors\.code\.invalid_totp_code/)).toBeNull();
  });

  /**
   * A refusal of the *draft* is the other half of the toast rule, and it is the opposite decision.
   *
   * `409 mfa_already_enabled` means the button did nothing; there is no field on screen it is about,
   * so it belongs to the one global toast rather than to an inline alert nobody asked for.
   */
  it('leaves a refused draft to the one global toast', async () => {
    const user = userEvent.setup();

    await startAt({ setup: () => problem('mfa_already_enabled', 409) });

    await user.click(await screen.findByRole('button', { name: /security\.totp\.enable/ }));

    expect(await screen.findByText(/errors\.code\.mfa_already_enabled/)).toBeInTheDocument();
    expect(screen.getAllByText(/errors\.code\.mfa_already_enabled/)).toHaveLength(1);
    // Still on the first face: nothing was drafted, so nothing is offered to confirm.
    expect(screen.queryByLabelText(/security\.totp\.code\.label/)).toBeNull();
  });

  /**
   * The side effect, asserted as a second request rather than as a callback that ran.
   *
   * The screen decides what it shows from `GET /auth/2fa/recovery-codes`, and that answer said «not
   * enrolled» a moment ago. Without the invalidation the person finishes enrolling and keeps
   * looking at an enrolment form whose button now answers 409 — and a spy on `onSuccess` would be
   * perfectly happy with an invalidation aimed at the wrong key.
   */
  it('asks the server again for the counter it has just changed', async () => {
    const user = userEvent.setup();

    await startAt();
    await beginEnrolment(user);

    const before = callsTo('/2fa/recovery-codes', 'GET').length;

    await fillConfirmation(user);
    await screen.findByRole('dialog');

    await waitFor(() => {
      expect(callsTo('/2fa/recovery-codes', 'GET').length).toBeGreaterThan(before);
    });
  });
});

describe('the codes that enrolment produces', () => {
  const enrol = async (user: UserEvent): Promise<HTMLElement> => {
    await startAt();
    await beginEnrolment(user);
    await fillConfirmation(user);

    return await screen.findByRole('dialog');
  };

  it('are all ten of them, and they are shown at once', async () => {
    const user = userEvent.setup();
    const dialog = within(await enrol(user));

    for (const code of CODES) expect(dialog.getByText(code)).toBeInTheDocument();
  });

  it('cannot be closed past, in any of the three ways a dialog usually closes', async () => {
    const user = userEvent.setup();
    const dialog = await enrol(user);

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBe(dialog);

    // The header cross and the button under the codes: both inert until the box is ticked, because
    // this window closing is the moment ten credentials stop existing in readable form.
    expect(
      within(dialog).getByRole('button', { name: /security\.codes\.dialog\.close/ }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: /security\.codes\.dialog\.done/ }),
    ).toBeDisabled();
  });

  it('close once the person says they have them, and the screen moves on', async () => {
    const user = userEvent.setup();
    const dialog = await enrol(user);

    await user.click(within(dialog).getByLabelText(/security\.codes\.dialog\.saved/));
    await user.click(within(dialog).getByRole('button', { name: /security\.codes\.dialog\.done/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // The enrolled face, which is the proof that the counter was re-read rather than assumed.
    expect(await screen.findByText(/security\.totp\.status\.on/)).toBeInTheDocument();
  });

  /**
   * Where the keyboard is left standing, in the flow that has no trigger to go back to.
   *
   * Confirming replaces the confirm form with the enrolled view, so the button that opened this
   * dialog is gone by the time it closes. Mantine's `returnFocus` aims at that node and lands on
   * `<body>` — a keyboard user dumped at the top of the document, tabbing through the whole shell.
   * The dialog moves focus to the page's `h1` instead, which is what the route announcer does when
   * what a page is about changes.
   */
  it('leaves the keyboard on the heading of the page it has just changed', async () => {
    const user = userEvent.setup();
    const dialog = await enrol(user);

    await user.click(within(dialog).getByLabelText(/security\.codes\.dialog\.saved/));
    await user.click(within(dialog).getByRole('button', { name: /security\.codes\.dialog\.done/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  /**
   * And the secret goes with them.
   *
   * By that point the authenticator holds it and the server holds it encrypted; the copy in this tab
   * is nothing but liability. Resetting only the codes would leave a base32 secret sitting in the
   * mutation cache of a screen that has moved on — which is why `dismissCodes` resets both.
   */
  it('take the drafted secret with them when they go', async () => {
    const user = userEvent.setup();
    const dialog = await enrol(user);

    await user.click(within(dialog).getByLabelText(/security\.codes\.dialog\.saved/));
    await user.click(within(dialog).getByRole('button', { name: /security\.codes\.dialog\.done/ }));

    await screen.findByText(/security\.totp\.status\.on/);

    expect(screen.queryByText(SECRET)).toBeNull();
    for (const code of CODES) expect(screen.queryByText(code)).toBeNull();
  });

  /**
   * The whole of «shown but not stored», in one case.
   *
   * Web Storage is already forbidden across the tree by
   * `test/architecture/data-layer-conventions.test.ts`, statically. This is the runtime half, and it
   * covers the two places a static scan cannot see: the address bar, and the next request out.
   */
  it('never reach storage, the address bar or a later request', async () => {
    const user = userEvent.setup();

    await enrol(user);

    const stored = JSON.stringify({ ...globalThis.localStorage, ...globalThis.sessionStorage });
    const sentBodies = JSON.stringify(sent.map((call) => ({ url: call.url, body: call.body })));

    for (const value of [SECRET, ...CODES]) {
      expect(stored).not.toContain(value);
      expect(globalThis.location.href).not.toContain(value);
      expect(sentBodies).not.toContain(value);
    }
  });
});

describe('accessibility of every state of the enrolment screen', () => {
  it('has no violation before anything is drafted', async () => {
    await startAt();
    await screen.findByRole('button', { name: /security\.totp\.enable/ });

    expect(await axeViolationsIn(document.body, { control: 'button-name' })).toEqual([]);
  });

  it('has no violation while the secret is on screen', async () => {
    const user = userEvent.setup();

    await startAt();
    await beginEnrolment(user);

    // `image-alt` is the control here rather than `button-name`: the QR is the element this state
    // adds, and a scan that found no image would be scanning the wrong subtree.
    expect(await axeViolationsIn(document.body, { control: 'image-alt' })).toEqual([]);
  });

  it('has no violation while the codes are on screen', async () => {
    const user = userEvent.setup();

    await startAt();
    await beginEnrolment(user);
    await fillConfirmation(user);

    expect(
      await axeViolationsIn(await screen.findByRole('dialog'), {
        modal: true,
        control: 'button-name',
      }),
    ).toEqual([]);
  });
});

/**
 * The one property `cimode` cannot state.
 *
 * Every assertion above matches a **key**, which is what makes them readable and what makes them
 * blind: `security.totp.warning.noDisable` matches whether the sentence says there is no way back
 * or says nothing at all. These three sentences are the entire reason this screen warns anybody, so
 * both catalogues are rendered for real and what is asserted is that a person is actually told.
 */
describe.each(['en', 'ru'] as const)('what the screen says in %s', (language) => {
  it('spells out all three consequences, in three different sentences', async () => {
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });

    await screen.findByRole('button', { name: i18n.t('security.totp.enable') });

    const sentences = [
      i18n.t('security.totp.warning.noDisable'),
      i18n.t('security.totp.warning.recoveryOnly'),
      i18n.t('security.totp.warning.lostAnswer'),
    ];

    // Three distinct sentences, none of them the key it came from: a namespace that failed to load
    // answers with the key, which is a string this loop would otherwise be perfectly happy with.
    expect(new Set(sentences).size).toBe(3);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/^security\./);
      expect(screen.getByText(sentence)).toBeInTheDocument();
    }

    // Nothing left un-interpolated anywhere on the screen: a placeholder on screen is a key that was
    // renamed on one side and not the other.
    expect(screen.queryByText(/\{\{/)).toBeNull();
  });
});
