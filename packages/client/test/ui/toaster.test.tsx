import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { render, screen, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18next, { type i18n as I18n } from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';

import { SharedUi } from '@shared';

/**
 * One action, one signal (`rules/errors-and-toasts.mdc` §2, §6).
 *
 * The defect this file exists for is not a crash: it is a stack of five identical red toasts after
 * a flaky endpoint answered five times, which every reviewer recognises and no assertion in the
 * suite would otherwise notice. `notify` therefore keys every signal by a stable id and *updates*
 * an existing toast rather than appending a second one.
 */

const Host = ({ children }: { readonly children?: ReactNode }) => (
  <MantineProvider env="test">
    <Notifications />
    {children}
  </MantineProvider>
);

afterEach(() => {
  SharedUi.notify.clear();
});

describe('notify', () => {
  it('shows one toast per failure, carrying the message key', async () => {
    render(<Host />);

    SharedUi.notify.error({ id: 'mutation-error:errors.conflict', messageKey: 'errors.conflict' });

    expect(await screen.findByText('errors.conflict')).toBeInTheDocument();
  });

  it('updates the same toast when the same failure repeats, instead of stacking', async () => {
    render(<Host />);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      SharedUi.notify.error({
        id: 'mutation-error:errors.conflict',
        messageKey: 'errors.conflict',
      });
    }

    await waitFor(() => {
      expect(screen.getAllByText('errors.conflict')).toHaveLength(1);
    });
  });

  it('keeps two different failures visible side by side', async () => {
    render(<Host />);

    SharedUi.notify.error({ id: 'mutation-error:errors.conflict', messageKey: 'errors.conflict' });
    SharedUi.notify.error({
      id: 'mutation-error:errors.forbidden',
      messageKey: 'errors.forbidden',
    });

    expect(await screen.findByText('errors.conflict')).toBeInTheDocument();
    expect(await screen.findByText('errors.forbidden')).toBeInTheDocument();
  });

  it('announces a failure assertively and a success politely', async () => {
    render(<Host />);

    SharedUi.notify.error({ id: 'e', messageKey: 'errors.conflict' });
    SharedUi.notify.success({ id: 's', messageKey: 'common.saved' });

    expect(await screen.findByRole('alert')).toHaveTextContent('errors.conflict');
    expect(await screen.findByRole('status')).toHaveTextContent('common.saved');
  });

  /**
   * A long operation owns one toast for its whole life: `loading` opens it, `success` or `error`
   * with the same id replaces its content. Two toasts for one operation is the same defect as a
   * stack of identical ones, one step earlier.
   */
  it('turns a loading toast into its outcome under the same id', async () => {
    render(<Host />);

    // Keys from a namespace this application actually loads. The invented `files.*` pair that used
    // to be here round-tripped only while the toaster rendered the key string verbatim; now that it
    // translates, an unknown namespace comes back shortened and the assertion would be about
    // i18next's fallback rather than about the toast being replaced.
    SharedUi.notify.loading({ id: 'import', messageKey: 'common.loading' });
    expect(await screen.findByText('common.loading')).toBeInTheDocument();

    SharedUi.notify.success({ id: 'import', messageKey: 'common.retry' });

    await waitFor(() => {
      expect(screen.queryByText('common.loading')).not.toBeInTheDocument();
    });
    expect(screen.getByText('common.retry')).toBeInTheDocument();
  });

  it('dismisses a toast on request', async () => {
    render(<Host />);

    SharedUi.notify.error({ id: 'gone', messageKey: 'errors.conflict' });
    expect(await screen.findByText('errors.conflict')).toBeInTheDocument();

    SharedUi.notify.dismiss('gone');

    await waitFor(() => {
      expect(screen.queryByText('errors.conflict')).not.toBeInTheDocument();
    });
  });

  /**
   * The port is what `shared/api` announces failures through (`createAppQueryClient`), and it is
   * the one seam that decides whether a failure is visible at all. Structural, so that a rename in
   * the data layer is a type error rather than a silent return to `silentNotifications`.
   */
  it('satisfies the notification port the data layer expects', () => {
    expect(typeof SharedUi.notify.error).toBe('function');
    expect(typeof SharedUi.notify.success).toBe('function');
  });
});

/**
 * A toast says a sentence, and the sentence comes from the catalogue.
 *
 * Asserted against a **real** instance rather than the suite's `cimode` one, and that is the whole
 * point of the file: in `cimode` a translated key and an untranslated key look identical, so a
 * toaster that forgot to translate at all would pass every other test in this repository. The wait
 * in a rate-limit message is interpolated for the same reason it is not concatenated — English puts
 * the number before the unit and Russian after, and a sentence glued in the source can only be
 * right in one of them.
 */
describe('what a toast actually says', () => {
  const translating = async (): Promise<I18n> => {
    const instance = i18next.createInstance();

    await instance.use(initReactI18next).init({
      lng: 'en',
      // The same separators and namespace list the application uses, or `errors.code.rate_limited`
      // splits into a namespace this instance never loaded and answers with the key — which is what
      // a toaster that failed to translate would also do, making the test unable to tell them apart.
      ns: ['errors'],
      defaultNS: 'errors',
      nsSeparator: '.',
      keySeparator: '.',
      resources: {
        en: {
          errors: { code: { rate_limited: 'Too many attempts. Try again in {{seconds}} s.' } },
        },
      },
      interpolation: { escapeValue: false },
    });

    return instance;
  };

  it('renders the catalogue sentence, not the key', async () => {
    render(
      <MantineProvider env="test">
        <I18nextProvider i18n={await translating()}>
          <Notifications />
        </I18nextProvider>
      </MantineProvider>,
    );

    SharedUi.notify.error({ id: 'rate', messageKey: 'errors.code.rate_limited' });

    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
    expect(screen.queryByText('errors.code.rate_limited')).not.toBeInTheDocument();
  });

  it('puts an interpolated value where the sentence wants it', async () => {
    render(
      <MantineProvider env="test">
        <I18nextProvider i18n={await translating()}>
          <Notifications />
        </I18nextProvider>
      </MantineProvider>,
    );

    SharedUi.notify.error({
      id: 'rate',
      messageKey: 'errors.code.rate_limited',
      values: { seconds: 30 },
    });

    expect(await screen.findByText('Too many attempts. Try again in 30 s.')).toBeInTheDocument();
  });
});

/**
 * The control that closes a toast, which for two epics had no name at all.
 *
 * Mantine draws it as an icon-only `CloseButton`: a screen reader announces «button», and axe
 * reports `button-name` against every toast the product raises. Nothing had caught it because the
 * cases above mount `<Notifications />` directly and none of them ever scanned a rendered toast —
 * it surfaced when axe was run over a screen that raises one (`test/widgets/totp-setup.test.tsx`).
 *
 * `Toaster` is the fix and the reason it is a component rather than an argument to `notify`: the
 * label is a sentence from the catalogue, and `notify` is a module-level utility with no context to
 * read one from.
 */
describe('the toast surface the application mounts', () => {
  it('gives the dismiss control a name a screen reader can read', async () => {
    render(
      <MantineProvider env="test">
        {/*
          The suite's `cimode` instance, named rather than inherited. `initReactI18next` sets the
          *global* default instance, so the ad-hoc English one built two cases above is what an
          unwrapped `useTranslation` would find here — an order dependency that answers with a
          different string depending on which file ran first.
        */}
        <I18nextProvider i18n={i18next}>
          <SharedUi.Toaster limit={3} position="top-right" />
        </I18nextProvider>
      </MantineProvider>,
    );

    SharedUi.notify.error({ id: 'named', messageKey: 'errors.conflict' });

    await screen.findByText('errors.conflict');

    // CONTROL of the assertion: the control exists at all, so «has a name» is about a button and
    // not about an empty query. `cimode` answers with the key, which is the string asserted.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'common.notification.dismiss' })).toBeInTheDocument();
  });
});
