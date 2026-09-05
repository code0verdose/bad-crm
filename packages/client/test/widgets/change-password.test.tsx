import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * Changing one's own password, on `/settings/security`.
 *
 * `POST /auth/change-password` shipped with EPIC-006 and was called by nothing for a month: the
 * operation existed, was tested on the server and was unreachable from the product. What this suite
 * states is the half a server test cannot:
 *
 *   * **three fields, and only two of them travel.** The confirmation exists because the input is
 *     masked and a typo is otherwise unrecoverable; it is not part of the contract and must not
 *     appear in the body;
 *   * **a refusal lands on the field it is about.** `401 invalid_credentials` is the server saying
 *     «that is not your password» — the same code a refused sign-in produces — and the person has
 *     to be told *which* of the three fields to fix. `rules/errors-and-toasts.mdc` §4 makes that an
 *     inline error, never a toast;
 *   * **one signal per action.** The mutation owns its failure, so the global toast stands aside;
 *   * **the strength meter is advisory and says so in words.** There is no strength policy on the
 *     server — `passwordSchema` is length only — so a meter that blocked submission would enforce a
 *     rule the product does not have. It reads out as a sentence rather than as a coloured bar,
 *     because colour is never the only carrier of meaning (`rules/a11y.mdc` §2);
 *   * **success closes the other sessions**, which is the whole point of the operation, so the list
 *     beside it is asked again rather than left showing what it read a minute ago.
 */

const CURRENT = 'correct horse battery';
const NEXT = 'staple generator lantern';

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

const noContent = (): Response => new Response(null, { status: 204 });

/** `application/problem+json` as the server produces it — `code` and `errors[]` are what the UI reads. */
const problem = (
  code: string,
  status: number,
  errors: readonly { path: string; code: string; message: string }[] = [],
): Response =>
  new Response(
    JSON.stringify({
      type: `https://bad-crm.dev/problems/${code}`,
      title: code,
      status,
      code,
      requestId: 'req-1',
      ...(errors.length === 0 ? {} : { errors }),
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

interface Answers {
  readonly change?: () => Response;
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({ change = noContent, i18n, language }: Answers = {}): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const raw = input.method === 'GET' ? '' : await input.clone().text();
    const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);

    sent.push({ url, method: input.method, body });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/auth/change-password')) return change();
    if (url.endsWith('/2fa/recovery-codes')) return json({ total: 0, remaining: 0 });
    if (url.endsWith('/auth/sessions')) return json({ items: [] });

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

const form = async (): Promise<HTMLElement> => {
  await screen.findByLabelText(/security\.password\.current\.label/);

  return screen.getByRole('button', { name: /security\.password\.submit/ }).closest('form')!;
};

interface Typed {
  readonly current?: string;
  readonly next?: string;
  readonly confirm?: string;
}

const fill = async (
  user: UserEvent,
  { current = CURRENT, next = NEXT, confirm = NEXT }: Typed = {},
): Promise<HTMLElement> => {
  const root = await form();
  const field = (label: RegExp) => within(root).getByLabelText(label);

  if (current !== '') await user.type(field(/security\.password\.current\.label/), current);
  if (next !== '') await user.type(field(/security\.password\.new\.label/), next);
  if (confirm !== '') await user.type(field(/security\.password\.confirm\.label/), confirm);

  return root;
};

const submit = async (user: UserEvent, root: HTMLElement): Promise<void> => {
  await user.click(within(root).getByRole('button', { name: /security\.password\.submit/ }));
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the form', () => {
  /**
   * Three fields, each telling the password manager what it is looking at.
   *
   * `current-password` on the first and `new-password` on the other two is what makes a manager
   * offer the stored password where it belongs and offer to *generate* one where it belongs —
   * getting it wrong on the middle field is how a manager helpfully fills in the password being
   * replaced.
   */
  it('asks for the current password once and the new one twice', async () => {
    await startAt();

    const root = await form();

    expect(within(root).getByLabelText(/security\.password\.current\.label/)).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(within(root).getByLabelText(/security\.password\.new\.label/)).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    expect(within(root).getByLabelText(/security\.password\.confirm\.label/)).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  it('sends nothing at all until it is submitted', async () => {
    await startAt();
    await form();

    expect(callsTo('/auth/change-password', 'POST')).toEqual([]);
  });

  /**
   * The confirmation never leaves the browser.
   *
   * `ChangePasswordRequest` has two properties and `additionalProperties: false`; a third would be
   * refused by the server as a validation failure — but the reason to assert it is not the contract,
   * it is that a password typed twice must not be sent twice.
   */
  it('sends the two passwords the contract names, and nothing else', async () => {
    const user = userEvent.setup();

    await startAt();
    await submit(user, await fill(user));

    await waitFor(() => {
      expect(callsTo('/auth/change-password', 'POST')).toHaveLength(1);
    });
    expect(callsTo('/auth/change-password', 'POST')[0]?.body).toEqual({
      currentPassword: CURRENT,
      newPassword: NEXT,
    });
  });
});

describe('what the form refuses before it asks the server', () => {
  it('refuses a new password shorter than the policy', async () => {
    const user = userEvent.setup();

    await startAt();
    await submit(user, await fill(user, { next: 'short', confirm: 'short' }));

    expect(await screen.findByText(/validation\.password\.too_short/)).toBeInTheDocument();
    expect(callsTo('/auth/change-password', 'POST')).toEqual([]);
  });

  /**
   * The mismatch is reported under the *second* field, which is the one to retype.
   *
   * Pointing it at the first would ask somebody to change the password they meant to choose because
   * they mistyped the copy of it.
   */
  it('refuses two new passwords that differ, under the field that has to be fixed', async () => {
    const user = userEvent.setup();

    await startAt();
    await submit(user, await fill(user, { confirm: `${NEXT} typo` }));

    const confirm = screen.getByLabelText(/security\.password\.confirm\.label/);

    expect(await screen.findByText(/validation\.password\.mismatch/)).toBeInTheDocument();
    expect(confirm).toHaveAttribute('aria-invalid', 'true');
    expect(callsTo('/auth/change-password', 'POST')).toEqual([]);
  });

  /**
   * A new password equal to the current one is refused here as well as there.
   *
   * The server answers `422 validation_failed` for it, so nothing is lost by sending it — except a
   * round trip and, on an installation with a rate limiter, one of a small number of attempts.
   */
  it('refuses a new password equal to the current one', async () => {
    const user = userEvent.setup();

    await startAt();
    await submit(user, await fill(user, { next: CURRENT, confirm: CURRENT }));

    expect(await screen.findByText(/validation\.password\.unchanged/)).toBeInTheDocument();
    expect(callsTo('/auth/change-password', 'POST')).toEqual([]);
  });
});

describe('a refusal from the server', () => {
  /**
   * `401 invalid_credentials` means one thing here and the field it means it about is knowable.
   *
   * Unlike `403 reauthentication_required` next door, which is deliberately opaque about which of
   * two proofs failed, this operation has exactly one proof: the current password. The contract says
   * so in as many words — «The client attaches the message to the `currentPassword` field; that is a
   * rendering decision, not a contract one».
   */
  it('puts a wrong current password under the field that is wrong', async () => {
    const user = userEvent.setup();

    await startAt({ change: () => problem('invalid_credentials', 401) });
    await submit(user, await fill(user));

    expect(await screen.findByText(/errors\.code\.invalid_credentials/)).toBeInTheDocument();
    expect(screen.getByLabelText(/security\.password\.current\.label/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // One action, one signal: an inline field error and no toast beside it.
    expect(screen.getAllByText(/errors\.code\.invalid_credentials/)).toHaveLength(1);
  });

  /** And it keeps the two new passwords, so the retry costs one field rather than three. */
  it('keeps what was typed', async () => {
    const user = userEvent.setup();

    await startAt({ change: () => problem('invalid_credentials', 401) });
    await submit(user, await fill(user));

    await screen.findByText(/errors\.code\.invalid_credentials/);

    expect(
      (screen.getByLabelText(/security\.password\.new\.label/) as HTMLInputElement).value,
    ).toBe(NEXT);
    expect(
      (screen.getByLabelText(/security\.password\.confirm\.label/) as HTMLInputElement).value,
    ).toBe(NEXT);
  });

  /**
   * A `422` names its field, and the client is expected to use the name rather than guess.
   *
   * This is the one refusal whose target the client cannot infer: the server rejects a policy
   * failure and a new password equal to the old one with the same code, both pointing at
   * `newPassword`, and a future rule could point somewhere else.
   */
  it('puts a field issue under the field the server named', async () => {
    const user = userEvent.setup();

    await startAt({
      change: () =>
        problem('validation_failed', 422, [
          { path: 'newPassword', code: 'too_small', message: 'too short' },
        ]),
    });
    await submit(user, await fill(user));

    expect(await screen.findByText(/errors\.field\.too_small/)).toBeInTheDocument();
    expect(screen.getByLabelText(/security\.password\.new\.label/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  /**
   * Anything with no field to land on is stated above the form, once.
   *
   * `429` is the realistic one: the operation shares a counter with sign-in, so somebody who has
   * just mistyped their password three times meets it here.
   */
  it('states a refusal that belongs to no field above the fields', async () => {
    const user = userEvent.setup();

    await startAt({ change: () => problem('rate_limited', 429) });
    await submit(user, await fill(user));

    const alert = (await screen.findByText(/security\.password\.failed\.title/)).closest(
      '[role="alert"]',
    ) as HTMLElement;

    expect(alert, 'the refusal is not inside a live region at all').not.toBeNull();
    expect(within(alert).getByText(/errors\.code\.rate_limited/)).toBeInTheDocument();
    expect(screen.getAllByText(/errors\.code\.rate_limited/)).toHaveLength(1);
  });
});

describe('success', () => {
  it('says so once, politely, and empties the form', async () => {
    const user = userEvent.setup();

    await startAt();
    await submit(user, await fill(user));

    const toast = (await screen.findByText(/security\.password\.done/)).closest('[role="status"]');

    expect(toast, 'the success is not inside a live region at all').not.toBeNull();
    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(screen.getAllByText(/security\.password\.done/)).toHaveLength(1);

    await waitFor(() => {
      expect(
        (screen.getByLabelText(/security\.password\.current\.label/) as HTMLInputElement).value,
      ).toBe('');
    });
  });

  /**
   * The session list is asked again, because the change closed every other session.
   *
   * A screen that left the list alone would show devices that were signed out by the very action
   * the person had just taken — and the list is right there, on the same screen.
   */
  it('asks for the sessions again, since the change closed them', async () => {
    const user = userEvent.setup();

    await startAt();

    const before = callsTo('/auth/sessions', 'GET').length;

    await submit(user, await fill(user));

    await waitFor(() => {
      expect(callsTo('/auth/sessions', 'GET').length).toBeGreaterThan(before);
    });
  });
});

describe('the strength meter', () => {
  /**
   * It reads out in words, and it changes as the password does.
   *
   * A coloured bar alone carries the meaning in colour, which `rules/a11y.mdc` §2 forbids; and the
   * whole content of a meter is the *difference* between one password and another, so a suite that
   * asserted one value could not tell a meter from a constant.
   */
  it('describes the password in words, and the words change with it', async () => {
    const user = userEvent.setup();

    await startAt();
    await form();

    const field = screen.getByLabelText(/security\.password\.new\.label/);

    await user.type(field, 'aaaaaaaaaaaa');
    expect(await screen.findByText(/security\.password\.strength\.weak/)).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, 'Tr0ubadour-Weaving-Lantern');
    expect(await screen.findByText(/security\.password\.strength\.strong/)).toBeInTheDocument();
  });

  /**
   * It never blocks. There is no strength policy on the server — `passwordSchema` is a length range
   * and nothing else — so a meter that refused a submission would enforce a rule the product does
   * not have, on the one screen where somebody is trying to secure their account.
   */
  it('does not stand between a weak-but-legal password and the server', async () => {
    const user = userEvent.setup();

    await startAt();
    await submit(user, await fill(user, { next: 'aaaaaaaaaaaa', confirm: 'aaaaaaaaaaaa' }));

    await waitFor(() => {
      expect(callsTo('/auth/change-password', 'POST')).toHaveLength(1);
    });
  });
});

describe('accessibility of the form', () => {
  it('has no violation at rest', async () => {
    await startAt();

    const root = await form();

    expect(await axeViolationsIn(root, { control: 'label' })).toEqual([]);
  });

  it('has no violation while a refusal is on screen', async () => {
    const user = userEvent.setup();

    await startAt({ change: () => problem('rate_limited', 429) });

    const root = await fill(user);

    await submit(user, root);
    await within(root).findByText(/security\.password\.failed\.title/);

    expect(await axeViolationsIn(root, { control: 'label' })).toEqual([]);
  });
});

/**
 * The one property `cimode` cannot state.
 *
 * Every assertion above matches a **key**: `security.password.strength.weak` matches whether the
 * sentence says anything about strength or is empty. The meter is the part of this screen whose
 * entire value is the words, so both catalogues are rendered for real.
 */
describe.each(['en', 'ru'] as const)('what the meter says in %s', (language) => {
  /**
   * A label rendered for real is «New password» plus the asterisk Mantine puts inside the same
   * element for a required field, so the accessible name is not the catalogue string on its own.
   * Anchored at the start rather than matched loosely: «New password» is a substring of «Repeat the
   * new password», and a loose match would find two fields and fail for a reason that has nothing to
   * do with what is being asserted.
   */
  const labelled = (text: string): RegExp =>
    new RegExp(`^${text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`);

  it('gives each level its own sentence, and shows the one the password earns', async () => {
    const i18n = SharedI18n.createI18n(language);
    const user = userEvent.setup();

    await startAt({ i18n, language });

    const field = await screen.findByLabelText(labelled(i18n.t('security.password.new.label')));
    const sentences = (['weak', 'fair', 'good', 'strong'] as const).map((level) =>
      i18n.t(`security.password.strength.${level}`),
    );

    // Four distinct sentences, none of them the key it came from: a namespace that failed to load
    // answers with the key, which is a string this loop would otherwise be perfectly happy with.
    expect(new Set(sentences).size).toBe(4);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/^security\./);
    }

    await user.type(field, 'aaaaaaaaaaaa');

    expect(await screen.findByText(i18n.t('security.password.strength.weak'))).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, 'Tr0ubadour-Weaving-Lantern');

    expect(
      await screen.findByText(i18n.t('security.password.strength.strong')),
    ).toBeInTheDocument();
    // Nothing left un-interpolated: a placeholder on screen is a key renamed on one side only.
    expect(screen.queryByText(/\{\{/)).toBeNull();
  });
});
