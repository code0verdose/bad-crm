import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';
import {
  expectFocusInside,
  expectFocusReturnedTo,
  focusEscapes,
  tabWrapFailures,
} from '../support/focus-trap.util.js';

/**
 * Turning the second factor **off** again, from `/settings/security`.
 *
 * Until this shipped there was no way out of 2FA in the product at all: enrolling was a one-way
 * door, and the day sign-in starts reading the second factor a lost phone becomes a lost account.
 * So the properties asserted here are the ones that make the door safe to open — and safe to leave
 * shut:
 *
 *   * **it costs something, and the cost is on screen before the button.** Switching off drops the
 *     account back to a password alone and destroys every remaining recovery code; both are
 *     irreversible in the sense that matters — turning it back on is a new secret and a new set;
 *   * **both proofs travel, and they travel together.** A session is not the second factor
 *     (`T-IAM-01`): the password and the code are what authorise this, and the request is worthless
 *     if either is dropped on the way;
 *   * **one field takes either shape.** The server decides from what was typed whether it is a live
 *     TOTP code or an unused recovery code, so the screen must not decide first — somebody whose
 *     authenticator is gone has only the printed sheet, and that is exactly the person who needs
 *     this screen;
 *   * **a refusal is inline and keeps what was typed.** `403 reauthentication_required` answers a
 *     wrong password, a wrong code and a spent recovery code alike, deliberately: the message
 *     belongs above both fields, not on either, and a form that emptied itself would make the
 *     second attempt cost the whole thing again;
 *   * **success is one green toast and a screen that asked the server what it now says**, not a
 *     screen that decided locally that 2FA must be off.
 */

const PASSWORD = 'correct horse battery staple';
const TOTP_CODE = '123456';
/** Ten characters — the shape `RecoveryCodesIssuedResult` publishes, and longer than a TOTP code. */
const RECOVERY_CODE = '23456ABCDE';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let sent: Call[];
/** What the counter answers — flipped by a successful disable, exactly as the server does. */
let enrolled: boolean;

const platformFetch = globalThis.fetch;

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** What `POST /auth/2fa/disable` answers when it works: 204, and nothing to read. */
const noContent = (): Response => new Response(null, { status: 204 });

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
  /** Evaluated per request, so the answer after a disable can differ from the read before it. */
  readonly disable?: () => Response;
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({
  disable = () => {
    enrolled = false;

    return noContent();
  },
  i18n,
  language,
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
    if (url.endsWith('/2fa/disable')) return disable();
    if (url.endsWith('/2fa/recovery-codes')) {
      return json(enrolled ? { total: 10, remaining: 7 } : { total: 0, remaining: 0 });
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

const triggerControl = (): HTMLElement =>
  screen.getByRole('button', { name: /security\.disable\.trigger/ });

const openDialog = async (user: UserEvent): Promise<HTMLElement> => {
  await screen.findByRole('button', { name: /security\.disable\.trigger/ });
  await user.click(triggerControl());

  return await screen.findByRole('dialog');
};

const fillAndSubmit = async (
  user: UserEvent,
  dialog: HTMLElement,
  code: string = TOTP_CODE,
): Promise<void> => {
  await user.type(within(dialog).getByLabelText(/security\.disable\.password\.label/), PASSWORD);
  await user.type(within(dialog).getByLabelText(/security\.disable\.code\.label/), code);
  await user.click(within(dialog).getByRole('button', { name: /security\.disable\.submit/ }));
};

beforeEach(() => {
  sent = [];
  enrolled = true;
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the way out, on the screen', () => {
  it('is offered once the second factor is on', async () => {
    await startAt();

    expect(
      await screen.findByRole('button', { name: /security\.disable\.trigger/ }),
    ).toBeInTheDocument();
    // CONTROL: the screen reached the enrolled face rather than merely rendering a button — the
    // counter it decides from was read and answered «on».
    expect(callsTo('/2fa/recovery-codes', 'GET').length).toBeGreaterThan(0);
    expect(screen.getByText(/security\.codes\.remaining/)).toBeInTheDocument();
  });

  /**
   * And it is absent when there is nothing to turn off.
   *
   * Not cosmetic: a control that asks for a password and a code from an account that has neither
   * would send somebody hunting for an authenticator app they never set up, and the server would
   * answer the same opaque `403` it answers a wrong password.
   */
  it('is not offered when the second factor is off', async () => {
    enrolled = false;

    await startAt();

    expect(
      await screen.findByRole('button', { name: /security\.totp\.enable/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /security\.disable\.trigger/ })).toBeNull();
  });

  it('asks for nothing until the dialog is opened', async () => {
    await startAt();
    await screen.findByRole('button', { name: /security\.disable\.trigger/ });

    expect(callsTo('/2fa/disable', 'POST')).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the confirmation', () => {
  it('names every consequence, above the button that causes them', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));

    // Each one individually: this is the set of things somebody cannot find out afterwards, and
    // «two of the three» is the failure this case exists to catch.
    expect(dialog.getByText(/security\.disable\.consequence\.passwordOnly/)).toBeInTheDocument();
    expect(dialog.getByText(/security\.disable\.consequence\.codes/)).toBeInTheDocument();
    expect(dialog.getByText(/security\.disable\.consequence\.again/)).toBeInTheDocument();

    // Above the button in the document, not merely somewhere in the dialog: a consequence under the
    // red button is a consequence read after the decision.
    expect(
      dialog
        .getByText(/security\.disable\.consequence\.codes/)
        .compareDocumentPosition(
          dialog.getByRole('button', { name: /security\.disable\.submit/ }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('asks for both proofs before it sends anything', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));

    await user.click(dialog.getByRole('button', { name: /security\.disable\.submit/ }));

    expect(await dialog.findByText(/validation\.password\.required/)).toBeInTheDocument();
    expect(dialog.getByText(/validation\.second_factor\.required/)).toBeInTheDocument();
    expect(callsTo('/2fa/disable', 'POST')).toEqual([]);
  });

  /**
   * The body, asserted field by field.
   *
   * A form that renders two inputs and posts one of them looks identical on screen and answers the
   * same opaque `403` the server gives a genuinely wrong password — so «it was refused» is not
   * evidence that both values left the browser. This is the case that says they did.
   */
  it('sends the password and the code together, in the body', async () => {
    const user = userEvent.setup();

    await startAt();
    await fillAndSubmit(user, await openDialog(user));

    await waitFor(() => {
      expect(callsTo('/2fa/disable', 'POST')).toHaveLength(1);
    });
    expect(callsTo('/2fa/disable', 'POST')[0]?.body).toEqual({
      password: PASSWORD,
      code: TOTP_CODE,
    });
  });

  /**
   * One field, either shape — and the recovery code arrives whole.
   *
   * The obvious implementation is the six-digit field this screen already owns twice
   * (`TotpCodeField`, `maxLength={6}`), and it would silently cut a ten-character recovery code to
   * `23456A`: the request goes out, the server refuses it as it refuses everything here, and the
   * one person this path exists for — the one whose authenticator is gone — is told nothing.
   */
  it('takes a recovery code in the same field, and sends it whole', async () => {
    const user = userEvent.setup();

    await startAt();
    await fillAndSubmit(user, await openDialog(user), RECOVERY_CODE);

    await waitFor(() => {
      expect(callsTo('/2fa/disable', 'POST')).toHaveLength(1);
    });
    expect(callsTo('/2fa/disable', 'POST')[0]?.body).toEqual({
      password: PASSWORD,
      code: RECOVERY_CODE,
    });
  });

  /**
   * The upper bound is the contract's (`DisableTotpRequest.code`, `maxLength: 32`), enforced at the
   * keystroke rather than after the round trip — the same bargain `TotpCodeField` makes at six.
   */
  it('stops at the length the contract accepts, rather than posting a refusal', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));
    const field = dialog.getByLabelText(/security\.disable\.code\.label/);

    await user.type(field, 'A'.repeat(40));

    expect((field as HTMLInputElement).value).toHaveLength(32);
  });
});

describe('a refusal', () => {
  /**
   * Above both fields, once, and with the typing still in place.
   *
   * `403 reauthentication_required` answers a wrong password, a wrong code and a recovery code that
   * was already spent — deliberately indistinguishable. Attaching it to a field would claim
   * knowledge the server refused to give; emptying the form would make the retry cost somebody
   * their whole password again, on a screen they reached because something already went wrong.
   */
  it('is shown beside the form, exactly once, and keeps what was typed', async () => {
    const user = userEvent.setup();

    await startAt({ disable: () => problem('reauthentication_required', 403) });

    const dialog = await openDialog(user);

    await fillAndSubmit(user, dialog);

    expect(await within(dialog).findByText(/security\.disable\.failed\.title/)).toBeInTheDocument();
    // One action, one signal: the mutation owns its failure, so the global toast stands aside.
    expect(screen.getAllByText(/errors\.code\.reauthentication_required/)).toHaveLength(1);

    expect(
      (within(dialog).getByLabelText(/security\.disable\.password\.label/) as HTMLInputElement)
        .value,
    ).toBe(PASSWORD);
    expect(
      (within(dialog).getByLabelText(/security\.disable\.code\.label/) as HTMLInputElement).value,
    ).toBe(TOTP_CODE);
  });

  it('leaves the second factor on, and the screen saying so', async () => {
    const user = userEvent.setup();

    await startAt({ disable: () => problem('reauthentication_required', 403) });
    await fillAndSubmit(user, await openDialog(user));

    await screen.findByText(/security\.disable\.failed\.title/);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/security\.codes\.remaining/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /security\.totp\.enable/ })).toBeNull();
  });
});

describe('success', () => {
  /**
   * The new state is read back rather than assumed.
   *
   * The counter on screen — «7 of 10 unused» — is a lie the instant the answer arrives, because the
   * server deleted the set in the same transaction. A screen that flipped a local boolean instead
   * would show «two-factor authentication is off» over a recovery-code section that is still there.
   */
  it('asks the server again, and the screen comes back saying the factor is off', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);
    const before = callsTo('/2fa/recovery-codes', 'GET').length;

    await fillAndSubmit(user, dialog);

    await waitFor(() => {
      expect(callsTo('/2fa/recovery-codes', 'GET').length).toBeGreaterThan(before);
    });
    expect(
      await screen.findByRole('button', { name: /security\.totp\.enable/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/security\.codes\.remaining/)).toBeNull();
  });

  it('says so once, politely, and closes the dialog', async () => {
    const user = userEvent.setup();

    await startAt();
    await fillAndSubmit(user, await openDialog(user));

    // Found through its own text rather than by `role="status"`: the route announcer is a live
    // region too, and `findByRole('status')` matches it as happily as the toast.
    const toast = (await screen.findByText(/security\.disable\.done/)).closest('[role="status"]');

    expect(toast, 'the success is not inside a live region at all').not.toBeNull();
    // A success waits its turn for a screen reader; only a failure interrupts (`rules/a11y.mdc` §13).
    expect(toast).toHaveAttribute('aria-live', 'polite');
    // One action, one signal — and nothing said it twice.
    expect(screen.getAllByText(/security\.disable\.done/)).toHaveLength(1);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('the keyboard', () => {
  it('puts the focus inside the dialog when it opens', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    await waitFor(() => {
      expect(expectFocusInside(dialog)).toBeInstanceOf(HTMLElement);
    });
  });

  it('keeps the focus inside itself, in both directions', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    // The reissue form is still on the screen behind, and its password field is a real, enabled,
    // tabbable input — without naming something the focus *could* have reached, «stayed inside» is
    // equally true of a page with nothing else on it.
    expect(
      await focusEscapes(
        user,
        dialog,
        screen.getByLabelText(/security\.codes\.regenerate\.password\.label/),
      ),
    ).toEqual([]);
  });

  it('wraps at both ends rather than swallowing the key', async () => {
    const user = userEvent.setup();

    await startAt();

    expect(await tabWrapFailures(user, await openDialog(user))).toEqual([]);
  });

  /**
   * `Escape` closes it — the ordinary answer of `rules/a11y.mdc` §6, and the right one here.
   *
   * Nothing irreplaceable is on screen (the recovery-code dialog's reason for refusing `Esc` does
   * not apply), and the safe outcome of this dialog is the one where nothing happens.
   */
  it('closes on Escape and puts the focus back on the control that opened it', async () => {
    const user = userEvent.setup();

    await startAt();
    await openDialog(user);

    const trigger = triggerControl();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opened the dialog');
    });
  });

  it('returns the focus to the trigger when it is cancelled', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);
    const trigger = triggerControl();

    await user.click(within(dialog).getByRole('button', { name: /security\.disable\.cancel/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opened the dialog');
    });
  });

  /**
   * After a *successful* disable the trigger does not exist to return to.
   *
   * The section it lives in is drawn by «2FA is on», and that stopped being true — focus returned to
   * a detached node is focus on `<body>`, which drops a keyboard user at the top of the shell. So it
   * goes to the page's `h1`, which is where the route announcer already sends it when what a page is
   * about changes (`rules/a11y.mdc` §21). What this page is about has just changed.
   */
  it('sends the focus to the page heading once there is no trigger left', async () => {
    const user = userEvent.setup();

    await startAt();
    await fillAndSubmit(user, await openDialog(user));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    });
    // CONTROL: nowhere is the failure this replaces — focus on `<body>`, which is what a return to a
    // detached trigger actually produces.
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('accessibility of the way out', () => {
  it('has no violation while the screen offers it', async () => {
    await startAt();
    await screen.findByRole('button', { name: /security\.disable\.trigger/ });

    expect(await axeViolationsIn(document.body, { control: 'button-name' })).toEqual([]);
  });

  it('has no violation while the confirmation is open', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    expect(
      await axeViolationsIn(dialog, {
        modal: true,
        // `label` rather than `button-name`: two inputs are what this state adds, and a scan of the
        // wrong subtree would miss exactly them.
        control: 'label',
      }),
    ).toEqual([]);
  });

  it('has no violation while a refusal is on screen', async () => {
    const user = userEvent.setup();

    await startAt({ disable: () => problem('reauthentication_required', 403) });

    const dialog = await openDialog(user);

    await fillAndSubmit(user, dialog);
    await within(dialog).findByText(/security\.disable\.failed\.title/);

    expect(await axeViolationsIn(dialog, { modal: true, control: 'label' })).toEqual([]);
  });
});

/**
 * The one property `cimode` cannot state.
 *
 * Every assertion above matches a **key**, which is what makes them readable and what makes them
 * blind: `security.disable.consequence.codes` matches whether the sentence explains that the
 * recovery codes are destroyed or says nothing at all. Those three sentences are the entire reason
 * this dialog exists rather than a bare red button, so both catalogues are rendered for real and
 * what is asserted is that a person is actually told.
 */
describe.each(['en', 'ru'] as const)('what the confirmation says in %s', (language) => {
  it('spells out all three consequences, in three different sentences', async () => {
    const i18n = SharedI18n.createI18n(language);
    const user = userEvent.setup();

    await startAt({ i18n, language });
    await screen.findByRole('button', { name: i18n.t('security.disable.trigger') });
    await user.click(screen.getByRole('button', { name: i18n.t('security.disable.trigger') }));

    const dialog = within(await screen.findByRole('dialog'));
    const sentences = [
      i18n.t('security.disable.consequence.passwordOnly'),
      i18n.t('security.disable.consequence.codes'),
      i18n.t('security.disable.consequence.again'),
    ];

    // Three distinct sentences, none of them the key it came from: a namespace that failed to load
    // answers with the key, which is a string this loop would otherwise be perfectly happy with.
    expect(new Set(sentences).size).toBe(3);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/^security\./);
      expect(dialog.getByText(sentence)).toBeInTheDocument();
    }

    // Nothing left un-interpolated: a placeholder on screen is a key renamed on one side only.
    expect(dialog.queryByText(/\{\{/)).toBeNull();
  });
});
