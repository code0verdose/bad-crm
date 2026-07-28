import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { render, screen, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
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

    SharedUi.notify.loading({ id: 'import', messageKey: 'files.import.running' });
    expect(await screen.findByText('files.import.running')).toBeInTheDocument();

    SharedUi.notify.success({ id: 'import', messageKey: 'files.import.done' });

    await waitFor(() => {
      expect(screen.queryByText('files.import.running')).not.toBeInTheDocument();
    });
    expect(screen.getByText('files.import.done')).toBeInTheDocument();
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
