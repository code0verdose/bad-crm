import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

import { ForgotPasswordForm } from '@units/auth/ui';

/**
 * The form that starts a password recovery — one field, and one thing it must never do.
 *
 * `POST /auth/forgot-password` answers 202 whether or not the address exists, and that constancy is
 * the whole design of the operation: a 404 for an unknown address, or a different screen for one,
 * would make this the enumeration oracle the sign-in form is carefully not
 * (`docs/api/openapi.yaml` → `requestPasswordReset`). The form's part of the bargain is that it
 * checks the *shape* of an address and nothing else — an address that is well formed always leaves
 * this component the same way.
 */
const renderForm = (props: Partial<Parameters<typeof ForgotPasswordForm>[0]> = {}) => {
  const onSubmit = vi.fn();

  const { container } = render(
    <MantineProvider env="test">
      <ForgotPasswordForm isPending={false} onSubmit={onSubmit} {...props} />
    </MantineProvider>,
  );

  return { container, onSubmit, user: userEvent.setup() };
};

const ask = async (user: ReturnType<typeof userEvent.setup>, email: string) => {
  await user.type(screen.getByLabelText(/auth\.forgotPassword\.email\.label/), email);
  await user.click(screen.getByRole('button', { name: 'auth.forgotPassword.submit' }));
};

describe('the password recovery form', () => {
  it('hands over an address that is well formed', async () => {
    const { onSubmit, user } = renderForm();

    await ask(user, 'ada@example.com');

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ email: 'ada@example.com' });
  });

  it('can be filled in and submitted with the keyboard alone', async () => {
    const { onSubmit, user } = renderForm();

    await user.tab();
    await user.keyboard('ada@example.com');
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('refuses an address that is not one, without asking the server', async () => {
    const { onSubmit, user } = renderForm();

    await ask(user, 'ada');

    expect(await screen.findByText('validation.email.invalid')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ties the message to the field and puts the focus there', async () => {
    const { user } = renderForm();

    await ask(user, 'ada');

    const email = screen.getByLabelText(/auth\.forgotPassword\.email\.label/);
    const message = await screen.findByText('validation.email.invalid');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email.getAttribute('aria-describedby')).toContain(message.id);
    await waitFor(() => {
      expect(document.activeElement).toBe(email);
    });
  });

  it('carries the wait on the submit button', () => {
    renderForm({ isPending: true });

    expect(screen.getByRole('button', { name: 'auth.forgotPassword.submit' })).toHaveAttribute(
      'data-loading',
      'true',
    );
  });

  it('has no accessibility violation, filled in or in error', async () => {
    const { container, user } = renderForm();
    await ask(user, 'ada');
    await screen.findByText('validation.email.invalid');

    const { violations } = await axe.run(container, {
      // Colours live in a stylesheet jsdom never loads; contrast is measured from the tokens in
      // `test/theme/tokens.test.ts`, where the real values are.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});
