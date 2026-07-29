import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

import { LoginForm } from '@units/auth/ui';

/**
 * The form, as somebody with no mouse meets it.
 *
 * Everything asserted here is load-bearing without a pointer and invisible in a screenshot: labels
 * that name their field, an error tied to the field through `aria-describedby`, focus that lands on
 * the field to fix rather than nowhere, and a submit that carries its own wait instead of a spinner
 * over the page (`rules/a11y.mdc` §18, `rules/errors-and-toasts.mdc` §7).
 *
 * A refused *sign-in* is not asserted here: the failure of the operation is one toast, raised once
 * by the global `MutationCache.onError` (`rules/errors-and-toasts.mdc` §3). What the form owns is
 * the other half — what the user typed is not a valid address, which belongs under the field.
 */
const renderForm = (props: Partial<Parameters<typeof LoginForm>[0]> = {}) => {
  const onSubmit = vi.fn();

  const { container } = render(
    <MantineProvider env="test">
      <LoginForm isPending={false} onSubmit={onSubmit} {...props} />
    </MantineProvider>,
  );

  return { container, onSubmit, user: userEvent.setup() };
};

const signIn = async (
  user: ReturnType<typeof userEvent.setup>,
  email: string,
  password: string,
) => {
  await user.type(screen.getByLabelText(/auth\.login\.email\.label/), email);
  await user.type(screen.getByLabelText(/auth\.login\.password\.label/), password);
  await user.click(screen.getByRole('button', { name: 'auth.login.submit' }));
};

describe('the sign-in form', () => {
  it('hands the credentials over when they are well formed', async () => {
    const { onSubmit, user } = renderForm();

    await signIn(user, 'ada@example.com', 'correct-horse-battery');

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      email: 'ada@example.com',
      password: 'correct-horse-battery',
    });
  });

  it('can be filled in and submitted with the keyboard alone', async () => {
    const { onSubmit, user } = renderForm();

    await user.tab();
    await user.keyboard('ada@example.com');
    await user.tab();
    await user.keyboard('correct-horse-battery');
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('refuses an address that is not one, without asking the server', async () => {
    const { onSubmit, user } = renderForm();

    await signIn(user, 'ada', 'correct-horse-battery');

    expect(await screen.findByText('validation.email.invalid')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ties the message to the field it belongs to, and marks the field invalid', async () => {
    const { user } = renderForm();

    await signIn(user, 'ada', 'correct-horse-battery');

    const email = screen.getByLabelText(/auth\.login\.email\.label/);
    const describedBy = await screen.findByText('validation.email.invalid');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email.getAttribute('aria-describedby')).toContain(describedBy.id);
  });

  it('puts the focus on the field that has to be fixed', async () => {
    const { user } = renderForm();

    await signIn(user, 'ada', 'correct-horse-battery');

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText(/auth\.login\.email\.label/));
    });
  });

  it('asks for a password rather than sending an empty one', async () => {
    const { onSubmit, user } = renderForm();

    await user.type(screen.getByLabelText(/auth\.login\.email\.label/), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'auth.login.submit' }));

    expect(await screen.findByText('validation.password.required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /**
   * The wait belongs to the control that started it — not to a page-wide spinner and not to a toast
   * saying «signing in» (`rules/errors-and-toasts.mdc` §7). The fields stay readable.
   */
  it('carries the wait on the submit button', () => {
    renderForm({ isPending: true });

    expect(screen.getByRole('button', { name: 'auth.login.submit' })).toHaveAttribute(
      'data-loading',
      'true',
    );
  });

  it('shows a notice the sign-in came back with, as an alert rather than a toast', () => {
    renderForm({ noticeKey: 'auth.login.organizationSelectionRequired' });

    expect(screen.getByRole('alert')).toHaveTextContent('auth.login.organizationSelectionRequired');
  });

  it('has no accessibility violation, filled in or in error', async () => {
    const { container, user } = renderForm();
    await signIn(user, 'ada', 'correct-horse-battery');
    await screen.findByText('validation.email.invalid');

    const { violations } = await axe.run(container, {
      // Colours live in a stylesheet jsdom never loads; contrast is measured from the tokens in
      // `test/theme/tokens.test.ts`, where the real values are.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});
