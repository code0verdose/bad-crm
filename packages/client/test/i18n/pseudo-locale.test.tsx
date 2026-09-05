/**
 * Renders the product in a language that is obviously not a language, and looks for text that did
 * not come from the catalogue.
 *
 * This is the check `i18next/no-literal-string` cannot make. The rule reads source and sees string
 * literals; it is blind to a sentence assembled at runtime, one supplied by a library's default
 * prop, and one baked into a component nobody thought of as text. Asking the *finished screen* sees
 * all three, because every catalogue string arrives wrapped in `⟦…⟧` and anything unwrapped came
 * from somewhere else.
 *
 * The length half is R-17 (`docs/product/prd.md`): Russian runs longer than English for the same
 * sentence. jsdom lays nothing out, so overflow itself cannot be asserted here — what *can* be
 * asserted, and is, is that a 40 % longer string still reaches the DOM intact rather than being
 * truncated by the component that renders it.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import i18next, { type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { SharedUi } from '@shared';

import { AuthUi } from '@units/auth';
import { EmployeeUi } from '@units/employee';
import { IamUi } from '@units/iam';
import { TeamUi } from '@units/team';

// The dialog rather than the widget that owns it — see the row it serves below.
import { DisableTotpDialog } from '@widgets/disable-totp/ui/disable-totp-dialog.component.js';

import {
  isPseudoLocalised,
  PSEUDO_MARKERS,
  pseudoLocalise,
  pseudoLocaliseValue,
} from '../support/pseudo-locale.util.js';
import { renderApp } from '../support/render-app.util.js';
import { setTestLanguage } from '../support/test-language.util.js';

/**
 * The catalogues as the bundle sees them, not as the filesystem does. This file runs in `jsdom`,
 * where `import.meta.url` is not a `file:` URL and `node:fs` has nothing to resolve against —
 * `import.meta.glob` is how Vite answers the same question, and it has the better property anyway:
 * a namespace added to the tree is picked up without anybody editing a list here.
 */
const CATALOGUES = import.meta.glob<Record<string, unknown>>(
  '../../src/shared/i18n/locales/en/*.json',
  { eager: true, import: 'default' },
);

const NAMESPACES = Object.keys(CATALOGUES).map(
  (path) =>
    path
      .split('/')
      .pop()
      ?.replace(/\.json$/, '') ?? '',
);

const pseudoResources = (): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(CATALOGUES).map(([path, tree]) => [
      path
        .split('/')
        .pop()
        ?.replace(/\.json$/, '') ?? '',
      pseudoLocalise(tree),
    ]),
  );

const pseudoInstance = async (): Promise<I18n> => {
  const instance = i18next.createInstance();

  await instance.use(initReactI18next).init({
    lng: 'pseudo',
    ns: NAMESPACES,
    defaultNS: 'common',
    nsSeparator: '.',
    keySeparator: '.',
    resources: { pseudo: pseudoResources() },
    interpolation: { escapeValue: false },
  });

  return instance;
};

/**
 * Text that is legitimately not a translation.
 *
 * `Bad CRM` is a proper noun and carries the same exemption it has in `topbar.component.tsx` and in
 * `index.html`. Everything else here is punctuation, digits or whitespace — a separator is not a
 * sentence, and demanding a catalogue entry for `·` would be the rule eating itself.
 */
const NOT_A_SENTENCE = /^[\s\d\p{P}\p{S}]*$/u;
const PROPER_NOUNS = new Set(['Bad CRM']);

/**
 * Every text node a reader could see, trimmed, with the empty ones dropped.
 *
 * `<style>` and `<script>` hold text nodes too — Mantine injects its whole variable sheet as one —
 * and a stylesheet is not a sentence anybody asked to have translated.
 */
const INVISIBLE_PARENTS = new Set(['STYLE', 'SCRIPT']);

const textNodes = (root: HTMLElement): string[] => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: string[] = [];

  let node = walker.nextNode();
  while (node !== null) {
    const text = node.textContent?.trim() ?? '';
    const parent = node.parentElement?.tagName ?? '';

    if (text !== '' && !INVISIBLE_PARENTS.has(parent)) found.push(text);
    node = walker.nextNode();
  }

  return found;
};

beforeEach(() => {
  localStorage.clear();
  // The application drives the instance now: `useLanguage` reads the stored choice and calls
  // `changeLanguage`. Seeding `cimode` here — the suite's usual answer — would pull the instance
  // straight back out of the pseudo locale, and every string would render as its own key.
  setTestLanguage('pseudo');
});

afterEach(async () => {
  if (i18next.language !== 'cimode') await i18next.changeLanguage('cimode');
});

describe('pseudoLocaliseValue', () => {
  it('marks the string and makes it about 40 % longer', () => {
    const value = pseudoLocaliseValue('Sign in');

    expect(value.startsWith(PSEUDO_MARKERS.open)).toBe(true);
    expect(value.endsWith(PSEUDO_MARKERS.close)).toBe(true);
    expect(value).toContain('Sign in');
    expect(value.length).toBeGreaterThan('Sign in'.length * 1.3);
  });

  /**
   * Expanding inside a placeholder would corrupt the value: `{{se·conds}}` interpolates nothing and
   * renders as itself. The one transformation that must not touch what it is padding.
   */
  it.each([
    ['an interpolation placeholder', 'Try again in {{seconds}} s.', '{{seconds}}'],
    ['a Trans tag', 'Read the <1>terms</1>.', '<1>'],
  ])('leaves %s intact', (_case, input, fragment) => {
    expect(pseudoLocaliseValue(input)).toContain(fragment);
  });

  it('walks a nested tree', () => {
    expect(pseudoLocalise({ a: { b: 'Save' }, c: 'Cancel' })).toEqual({
      a: { b: pseudoLocaliseValue('Save') },
      c: pseudoLocaliseValue('Cancel'),
    });
  });

  it.each([
    ['CONTROL: recognises a marked string', pseudoLocaliseValue('Save'), true],
    ['CONTROL: leaves a plain string unrecognised', 'Save', false],
  ])('%s', (_case, value, expected) => {
    expect(isPseudoLocalised(value)).toBe(expected);
  });
});

/**
 * The screens an installation always shows. A hardcoded string on either of them is a string half
 * the product's readers cannot read, and neither the parity gate nor the lint rule would say so.
 */
describe.each([
  ['the sign-in screen', '/login', 'anonymous'],
  ['the authenticated shell', '/dashboard', 'authenticated'],
] as const)('%s in a pseudo locale', (_case, path, status) => {
  const mount = async () => {
    const { container } = renderApp({
      path,
      status,
      i18n: await pseudoInstance(),
      language: 'pseudo',
    });
    await screen.findByRole('heading', { level: 1 });

    return container;
  };

  it('shows nothing that did not come from the catalogue', async () => {
    const unmarked = textNodes(await mount()).filter(
      (text) => !isPseudoLocalised(text) && !NOT_A_SENTENCE.test(text) && !PROPER_NOUNS.has(text),
    );

    expect(unmarked).toEqual([]);
  });

  /**
   * CONTROL: the walker has to find text at all, and it has to be *this* screen's text.
   *
   * The first version of this file mounted `<App/>` directly with no session, so the guard sent the
   * `/dashboard` case to the sign-in screen and both cases asserted about the same page — green,
   * and blind to every string in the shell. It was caught by planting a hardcoded sentence in the
   * topbar and watching the suite stay green, which is the only way that class of mistake ever
   * surfaces.
   */
  it('CONTROL: is looking at the screen it names', async () => {
    const container = await mount();
    const marked = textNodes(container).filter(isPseudoLocalised);

    expect(marked.length).toBeGreaterThan(3);
    expect(container.querySelector('header') !== null).toBe(status === 'authenticated');
  });
});

/**
 * The states a screen falls into, which the two routes above never reach.
 *
 * The pair of cases above mounts `/login` and `/dashboard` in their **happy** state, so a string
 * that only appears when something fails is not on screen for them to look at. That is precisely
 * where a missing `t()` survived: `ErrorState` rendered its retry label as
 * `{retryLabelKey}` — the raw key — while translating the message beside it, and every screen with
 * a failed query showed a button reading `common.retry`.
 *
 * **Why no other test caught it.** The suite's default i18next instance runs in `cimode`, where
 * `t(key)` returns the key. Under `cimode` a component that forgets `t()` renders **identically**
 * to one that remembers, so `data-state.test.tsx` asserting `{ name: 'common.retry' }` passed
 * either way and locked the defect in. Only a locale that transforms its values can tell the two
 * apart, which is the whole reason this file exists — it just was not pointed at these components.
 */
describe('the shared states in a pseudo locale', () => {
  const mountState = async (ui: React.ReactNode): Promise<HTMLElement> => {
    const instance = await pseudoInstance();

    const { container } = render(
      <I18nextProvider i18n={instance}>
        <MantineProvider>{ui}</MantineProvider>
      </I18nextProvider>,
    );

    return container;
  };

  const unmarkedIn = (container: HTMLElement): string[] =>
    textNodes(container).filter(
      (text) => !isPseudoLocalised(text) && !NOT_A_SENTENCE.test(text) && !PROPER_NOUNS.has(text),
    );

  it('shows nothing unmarked when a query failed and offers a retry', async () => {
    const container = await mountState(
      <SharedUi.DataState
        errorMessageKey="errors.route.failed"
        onRetry={() => undefined}
        skeleton={<p>loading</p>}
        status="error"
      >
        <p>rows</p>
      </SharedUi.DataState>,
    );

    expect(unmarkedIn(container)).toEqual([]);
  });

  /** CONTROL: the walker has to be finding this component's text, not an empty container. */
  it('CONTROL: is looking at the failed state it names', async () => {
    const container = await mountState(
      <SharedUi.DataState
        errorMessageKey="errors.route.failed"
        onRetry={() => undefined}
        skeleton={<p>loading</p>}
        status="error"
      >
        <p>rows</p>
      </SharedUi.DataState>,
    );

    expect(textNodes(container).filter(isPseudoLocalised).length).toBeGreaterThan(1);
  });
});

/**
 * The second-factor step, which neither route above ever reaches.
 *
 * `/login` is mounted in its happy state, so the step that appears *after* a correct password is
 * not on screen for the walker to look at — and the whole client suite runs in `cimode`, where a
 * component that forgot `t()` renders identically to one that remembers. Every string of this step
 * would therefore be invisible to both gates at once, which is exactly the hole `ErrorState` fell
 * through before this file was pointed at it.
 *
 * The countdown is asserted here for the same reason and no other: `cimode` answers with the key and
 * drops the interpolation, so `{{time}}` can only be shown to work where a real catalogue is loaded.
 */
describe('the second-factor step in a pseudo locale', () => {
  const mountStep = async (): Promise<HTMLElement> => {
    const instance = await pseudoInstance();

    const { container } = render(
      <I18nextProvider i18n={instance}>
        <MantineProvider>
          <AuthUi.TwoFactorForm
            failureKey="errors.code.mfa_invalid_code"
            isPending={false}
            onSubmit={() => undefined}
            secondsLeft={287}
          />
        </MantineProvider>
      </I18nextProvider>,
    );

    return container;
  };

  it('shows nothing that did not come from the catalogue', async () => {
    const unmarked = textNodes(await mountStep()).filter(
      (text) => !isPseudoLocalised(text) && !NOT_A_SENTENCE.test(text) && !PROPER_NOUNS.has(text),
    );

    expect(unmarked).toEqual([]);
  });

  it('puts the time left into the sentence that has a place for it', async () => {
    const container = await mountStep();

    expect(container.textContent).toContain('4:47');
  });

  /** CONTROL: the walker has to be finding this step's text, not an empty container. */
  it('CONTROL: is looking at the step it names', async () => {
    const container = await mountStep();

    expect(textNodes(container).filter(isPseudoLocalised).length).toBeGreaterThan(3);
  });
});

/**
 * The change-password form in its two unhappy states, which no route case above reaches.
 *
 * Both are states somebody only ever sees when something has already gone wrong, and both are
 * assembled at render time rather than written into the markup — which is the exact combination the
 * two gates are blind to. `i18next/no-literal-string` reads source and sees no literal, because the
 * sentence arrives as a key from a hook; the rest of the suite runs in `cimode`, where a component
 * that forgot `t()` renders **identically** to one that remembered. That is how `ErrorState` shipped
 * a button reading `common.retry`, twice, before this file was pointed at it.
 *
 * The strength meter is the second half and it is the same shape: four sentences chosen by
 * arithmetic, none of them written in a component, all of them the entire content of the control.
 */
describe('the change-password form in a pseudo locale', () => {
  const mountForm = async (failure: {
    readonly fieldErrors: Readonly<Record<string, string>>;
    readonly alertKey: string | undefined;
  }): Promise<HTMLElement> => {
    const instance = await pseudoInstance();

    const { container } = render(
      <I18nextProvider i18n={instance}>
        <MantineProvider>
          <AuthUi.ChangePasswordForm
            failure={failure}
            isPending={false}
            onSubmit={() => undefined}
          />
        </MantineProvider>
      </I18nextProvider>,
    );

    return container;
  };

  const unmarked = (container: HTMLElement): string[] =>
    textNodes(container).filter(
      (text) => !isPseudoLocalised(text) && !NOT_A_SENTENCE.test(text) && !PROPER_NOUNS.has(text),
    );

  it('shows the refusal as a sentence, not as a key', async () => {
    const container = await mountForm({
      fieldErrors: {},
      alertKey: 'errors.code.rate_limited',
    });

    expect(unmarked(container)).toEqual([]);
  });

  /** CONTROL: the alert is on screen at all — one that never rendered would also pass. */
  it('CONTROL: is looking at the refusal it names', async () => {
    const container = await mountForm({
      fieldErrors: {},
      alertKey: 'errors.code.rate_limited',
    });
    const alert = container.querySelector('[role="alert"]');

    expect(alert).not.toBeNull();
    expect(isPseudoLocalised(alert?.textContent ?? '')).toBe(true);
  });

  it('shows the strength of the field as a sentence too', async () => {
    const instance = await pseudoInstance();
    const container = await mountForm({ fieldErrors: {}, alertKey: undefined });

    expect(unmarked(container)).toEqual([]);
    // Named, not merely «nothing unmarked»: a meter that rendered no text at all would satisfy the
    // line above, and the words are the whole of what this control is.
    expect(container.textContent).toContain(instance.t('security.password.strength.weak'));
  });
});

/**
 * The notice above the sign-in fields, which the `/login` case above never reaches either.
 *
 * `noticeKey` is `undefined` on a screen nobody has submitted yet, so the happy mount walks past
 * an `Alert` that is not rendered. The form shipped with `title={noticeKey}` — the raw key — and
 * the component's own test asserted `getByRole('alert')` has the text
 * `auth.login.organizationSelectionRequired`, which is exactly what `cimode` produces from a
 * *correct* `t(noticeKey)`. Same shape as the `ErrorState` defect above, second occurrence, found
 * 2026-08-30 and fixed in the same change.
 *
 * Both keys the hook can pass are mounted, because they arrive from different namespaces:
 * `auth.*` from the answer to a well-formed sign-in, `errors.code.*` borrowed from the server's
 * vocabulary for a second factor whose countdown ran out (`use-login.hook.ts`).
 */
describe.each([
  ['an address that belongs to two organizations', 'auth.login.organizationSelectionRequired'],
  ['a second factor whose countdown ran out', 'errors.code.mfa_token_expired'],
])('the sign-in notice for %s', (_case, noticeKey) => {
  const mountForm = async (): Promise<HTMLElement> => {
    const instance = await pseudoInstance();

    const { container } = render(
      <I18nextProvider i18n={instance}>
        <MantineProvider>
          <AuthUi.LoginForm isPending={false} noticeKey={noticeKey} onSubmit={() => undefined} />
        </MantineProvider>
      </I18nextProvider>,
    );

    return container;
  };

  it('shows the sentence, not the key', async () => {
    const unmarked = textNodes(await mountForm()).filter(
      (text) => !isPseudoLocalised(text) && !NOT_A_SENTENCE.test(text) && !PROPER_NOUNS.has(text),
    );

    expect(unmarked).toEqual([]);
  });

  /** CONTROL: the notice is on screen at all — an `Alert` that never rendered would also pass. */
  it('CONTROL: is looking at the notice it names', async () => {
    const container = await mountForm();
    const alert = container.querySelector('[role="alert"]');

    expect(alert).not.toBeNull();
    expect(isPseudoLocalised(alert?.textContent ?? '')).toBe(true);
  });
});

/**
 * The registration screen in its two unhappy states, neither of which any happy mount reaches.
 *
 * `/register` is where an installation is created, so the states that matter most are the ones an
 * operator meets when it *cannot* be: a slug somebody else has taken, and an installation whose
 * `REGISTRATION_OPEN` is `false`. Both replace or annotate what is on screen with a sentence, and
 * both are invisible to the rest of the suite for the reason this file exists — `cimode` renders a
 * forgotten `t()` identically to a remembered one.
 *
 * The closed panel is mounted rather than described because it is the only text in the product a
 * person sees *instead of* a form: if it rendered as `auth.register.closed.description`, the last
 * thing a new installation would say for itself is a dotted key.
 */
describe('the registration screen in a pseudo locale', () => {
  const mountRegistration = async (
    element: React.ReactNode = (
      <AuthUi.RegisterForm
        isPending={false}
        noticeKey="errors.code.rate_limited"
        onSubmit={() => undefined}
        slugErrorKey="errors.code.organization_already_exists"
      />
    ),
  ): Promise<HTMLElement> => {
    const instance = await pseudoInstance();

    const { container } = render(
      <I18nextProvider i18n={instance}>
        <MantineProvider>{element}</MantineProvider>
      </I18nextProvider>,
    );

    return container;
  };

  it('shows nothing unmarked on the form, its notice or its refused field', async () => {
    const unmarked = textNodes(await mountRegistration()).filter(
      (text) => !isPseudoLocalised(text) && !NOT_A_SENTENCE.test(text) && !PROPER_NOUNS.has(text),
    );

    expect(unmarked).toEqual([]);
  });

  it('shows nothing unmarked when the installation is closed to registration', async () => {
    const unmarked = textNodes(await mountRegistration(<AuthUi.RegistrationClosed />)).filter(
      (text) => !isPseudoLocalised(text) && !NOT_A_SENTENCE.test(text) && !PROPER_NOUNS.has(text),
    );

    expect(unmarked).toEqual([]);
  });

  /** CONTROL: both mounts have to be finding their own text, not an empty container. */
  it.each([
    ['the form', undefined],
    ['the closed panel', <AuthUi.RegistrationClosed key="closed" />],
  ])('CONTROL: is looking at %s it names', async (_case, element) => {
    const container = await mountRegistration(element ?? undefined);

    expect(textNodes(container).filter(isPseudoLocalised).length).toBeGreaterThan(1);
  });

  /**
   * The field messages, which are the reason this screen translates its resolver at all.
   *
   * Every schema in the repository answers with an i18n **key**, and `@mantine/form` renders what
   * the resolver returned — so a form wiring `schemaResolver` straight into `validate` shows
   * `validation.email.invalid` under the field, in both languages. `cimode` renders that exactly
   * like a correct translation, which is why the defect can only be caught here.
   */
  it('translates the messages its own schema produced', async () => {
    const user = userEvent.setup();
    const container = await mountRegistration(
      <AuthUi.RegisterForm isPending={false} onSubmit={() => undefined} />,
    );

    // Queried by shape rather than by name: every label on screen is pseudo-localised, so matching
    // one by its text would mean writing the transformation out a second time.
    const email = container.querySelector<HTMLInputElement>('input[type="email"]');
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    await user.type(email as HTMLInputElement, 'ada');
    await user.click(submit as HTMLButtonElement);

    const message = container.querySelector('.mantine-TextInput-error');
    expect(message).not.toBeNull();
    expect(isPseudoLocalised(message?.textContent ?? '')).toBe(true);
  });
});

/**
 * The panel that replaces the form once a password reset has been asked for.
 *
 * It shipped printing `auth.forgotPassword.sent` — the key itself — into an `Alert` with
 * `role="status"`, which means the one sentence telling somebody to go and look in their mail was
 * never a sentence. Found 2026-08-30, the fourth of this exact shape in a month; the previous three
 * were `ErrorState`'s retry label, the sign-in notice and every field message a schema produces.
 *
 * Nothing else could have caught it. The suite runs in `cimode`, where `t(key)` answers with the
 * key, so the component that forgot `t()` rendered byte for byte like the one that remembered — and
 * the component's own test asserted the key was on screen, which was true either way.
 */
describe('the password-reset confirmation in a pseudo locale', () => {
  it('shows the sentence, not the key', async () => {
    const instance = await pseudoInstance();

    const { container } = render(
      <I18nextProvider i18n={instance}>
        <MantineProvider>
          <AuthUi.PasswordResetSent />
        </MantineProvider>
      </I18nextProvider>,
    );

    const status = container.querySelector('[role="status"]');

    expect(status).not.toBeNull();
    expect(isPseudoLocalised(status?.textContent ?? '')).toBe(true);
  });
});

/**
 * Every other form in the product, asked the one question `cimode` cannot answer: is the message
 * under the field a sentence?
 *
 * The registration case above is the same assertion for one form. This block is the rest of them,
 * and there is no shorter way to write it: the defect is per-component — `validate:
 * schemaResolver(schema, { sync: true })` hands `@mantine/form` a record of i18n **keys**, and
 * Mantine renders what it is handed. Thirteen forms shipped that way, so thirteen fields read
 * `validation.password.required` in both languages, and no test in the tree could tell — under
 * `cimode` `t(key)` *is* the key, so an assertion naming the key passes whether or not anything
 * translated it. Only a locale that transforms its values separates the two.
 *
 * Each row breaks the form in the cheapest way that reaches a **keyed** message: an empty required
 * field, or an empty one among otherwise valid values where the form starts filled in. Rows are not
 * asked «is nothing on screen unmarked» — a few bounds in these schemas (`max(120)` on a name,
 * `min(1)` on a timezone) carry no key and fall back to Zod's own English, which is a separate
 * defect and not this one. The question asked is narrower and exactly the class: *the message this
 * schema produced* arrived translated.
 *
 * `test/architecture/form-issue-translation.test.ts` is what keeps the next form from arriving
 * without a row here.
 */
describe('the field messages of every form in a pseudo locale', () => {
  const LOCALE = 'en' as const;

  const TEAM_VALUES = { name: '', slug: '', description: '' };

  const OVERRIDE_VALUES = { reason: '', neverExpires: true, expiresOn: '' };

  /** A profile that is valid everywhere except the field the row is about. */
  const PROFILE_VALUES = {
    firstName: '',
    lastName: 'Lovelace',
    jobTitle: '',
    department: '',
    employmentType: 'FULL_TIME' as const,
    weeklyCapacityHours: '40',
    timezone: 'UTC',
    skills: '',
    emergencyContact: '',
  };

  const noop = () => undefined;

  const FORMS: readonly (readonly [string, React.ReactNode])[] = [
    ['the sign-in form', <AuthUi.LoginForm isPending={false} onSubmit={noop} />],
    ['the password-recovery form', <AuthUi.ForgotPasswordForm isPending={false} onSubmit={noop} />],
    ['the password-reset form', <AuthUi.ResetPasswordForm isPending={false} onSubmit={noop} />],
    [
      'the second-factor step',
      <AuthUi.TwoFactorForm
        failureKey={undefined}
        isPending={false}
        onSubmit={noop}
        secondsLeft={287}
      />,
    ],
    [
      'the second-factor enrolment',
      <AuthUi.TotpConfirmForm
        failureKey={undefined}
        isPending={false}
        onCancel={noop}
        onSubmit={noop}
      />,
    ],
    [
      'the recovery-code replacement',
      <AuthUi.RegenerateRecoveryCodesForm
        failureKey={undefined}
        isPending={false}
        onSubmit={noop}
      />,
    ],
    [
      'the invitation acceptance',
      <IamUi.AcceptInvitationForm defaultLocale={LOCALE} isPending={false} onSubmit={noop} />,
    ],
    [
      'the invitation form',
      <IamUi.InviteForm
        defaultLocale={LOCALE}
        isPending={false}
        onSubmit={noop}
        roles={[{ value: 'r-1', label: 'Member' }]}
      />,
    ],
    [
      'the permission exception',
      <IamUi.PermissionOverrideForm
        effect="ALLOW"
        initialValues={OVERRIDE_VALUES}
        isPending={false}
        onCancel={noop}
        onSubmit={noop}
        permission="task:create"
      />,
    ],
    [
      'the team form',
      <TeamUi.TeamForm
        initialValues={TEAM_VALUES}
        isPending={false}
        onSubmit={noop}
        submitLabelKey="teams.create.submit"
      />,
    ],
    [
      'the employee profile',
      <EmployeeUi.EmployeeProfileForm
        canEditEmployment
        carriesEmergencyContact
        initialValues={PROFILE_VALUES}
        isPending={false}
        onSubmit={noop}
      />,
    ],
    [
      'the change-password form',
      <AuthUi.ChangePasswordForm
        failure={{ fieldErrors: {}, alertKey: undefined }}
        isPending={false}
        onSubmit={noop}
      />,
    ],
    [
      'the second-factor removal dialog',
      // Mounted from inside the widget rather than through it: the widget's public face is the
      // section on `/settings/security`, and reaching the dialog through it means a route, a
      // session and the counter request that decides whether the trigger is drawn at all — all of
      // which `test/widgets/disable-totp.test.tsx` already owns. The form is what this row is about.
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DisableTotpDialog onCancel={noop} onDisabled={noop} />
      </QueryClientProvider>,
    ],
  ];

  const mount = async (element: React.ReactNode): Promise<void> => {
    const instance = await pseudoInstance();

    render(
      <I18nextProvider i18n={instance}>
        <MantineProvider>{element}</MantineProvider>
      </I18nextProvider>,
    );
  };

  /**
   * Mantine puts a field's message in the element it points `aria-describedby` at, so the messages
   * are read from the document rather than from a container: a dialog renders into a portal, and a
   * container query would find an empty div and call it a pass.
   */
  const fieldMessages = (): string[] =>
    [...document.body.querySelectorAll('[class*="InputWrapper-error"]')]
      .map((element) => element.textContent?.trim() ?? '')
      .filter((text) => text !== '');

  const submit = async (): Promise<void> => {
    const user = userEvent.setup();
    const button = document.body.querySelector<HTMLButtonElement>('button[type="submit"]');

    await user.click(button as HTMLButtonElement);
  };

  it.each(FORMS)('%s translates the messages its own schema produced', async (_case, element) => {
    await mount(element);
    await submit();

    const messages = fieldMessages();

    // CONTROL: the submit was refused and something was drawn under a field. A form that submitted
    // cleanly, or one whose button was never found, leaves nothing to look at — and «every message
    // is translated» is true of no messages at all.
    expect(messages).not.toEqual([]);
    expect(messages.filter((text) => !isPseudoLocalised(text))).toEqual([]);
  });
});
