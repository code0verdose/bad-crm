import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

import { ResetPasswordForm } from '@units/auth/ui';

/**
 * The form that spends a reset link: a new password, typed twice, and no token anywhere in sight.
 *
 * The token is not a field of this form and is not rendered by it. It arrives in the path of the
 * SPA route, the page reads it there, and it travels to the server in the **body** of
 * `POST /auth/reset-password` — a query string is written to the access log of every proxy, handed
 * to the next origin in `Referer`, and copied along with the link (`docs/security/threat-model.md`,
 * T-IAM-07).
 *
 * The confirmation field is not decoration either: this is the one form in the product where the
 * user cannot read back what they typed and cannot try again if they are wrong — the token is spent
 * and the password is whatever the typo made it.
 */
const VALID_PASSWORD = 'staple-generator-lantern';

const renderForm = (props: Partial<Parameters<typeof ResetPasswordForm>[0]> = {}) => {
  const onSubmit = vi.fn();

  const { container } = render(
    <MantineProvider env="test">
      <ResetPasswordForm isPending={false} onSubmit={onSubmit} {...props} />
    </MantineProvider>,
  );

  return { container, onSubmit, user: userEvent.setup() };
};

const setPassword = async (
  user: ReturnType<typeof userEvent.setup>,
  newPassword: string,
  confirmPassword: string,
) => {
  await user.type(screen.getByLabelText(/auth\.resetPassword\.newPassword\.label/), newPassword);
  await user.type(
    screen.getByLabelText(/auth\.resetPassword\.confirmPassword\.label/),
    confirmPassword,
  );
  await user.click(screen.getByRole('button', { name: 'auth.resetPassword.submit' }));
};

describe('the password reset form', () => {
  it('hands over a password that satisfies the policy and was typed twice', async () => {
    const { onSubmit, user } = renderForm();

    await setPassword(user, VALID_PASSWORD, VALID_PASSWORD);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      newPassword: VALID_PASSWORD,
      confirmPassword: VALID_PASSWORD,
    });
  });

  it('can be filled in and submitted with the keyboard alone', async () => {
    const { onSubmit, user } = renderForm();

    await user.tab();
    await user.keyboard(VALID_PASSWORD);
    await user.tab();
    await user.keyboard(VALID_PASSWORD);
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  /**
   * The policy is the shared one, so «what counts as a password» is one answer for this screen, for
   * registration and for the server. Checking it here saves a round trip that would spend nothing —
   * the token survives a 422 — but would tell the user later what it can tell them now.
   */
  it('refuses a password shorter than the policy allows, without asking the server', async () => {
    const { onSubmit, user } = renderForm();

    await setPassword(user, 'short', 'short');

    expect(await screen.findByText('validation.password.too_short')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a confirmation that does not match, and says so under that field', async () => {
    const { onSubmit, user } = renderForm();

    await setPassword(user, VALID_PASSWORD, `${VALID_PASSWORD}x`);

    const confirmation = screen.getByLabelText(/auth\.resetPassword\.confirmPassword\.label/);
    const message = await screen.findByText('validation.password.mismatch');
    expect(confirmation).toHaveAttribute('aria-invalid', 'true');
    expect(confirmation.getAttribute('aria-describedby')).toContain(message.id);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('puts the focus on the field that has to be fixed', async () => {
    const { user } = renderForm();

    await setPassword(user, VALID_PASSWORD, `${VALID_PASSWORD}x`);

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByLabelText(/auth\.resetPassword\.confirmPassword\.label/),
      );
    });
  });

  it('carries the wait on the submit button', () => {
    renderForm({ isPending: true });

    expect(screen.getByRole('button', { name: 'auth.resetPassword.submit' })).toHaveAttribute(
      'data-loading',
      'true',
    );
  });

  it('has no accessibility violation, filled in or in error', async () => {
    const { container, user } = renderForm();
    await setPassword(user, VALID_PASSWORD, 'nope');
    await screen.findByText('validation.password.mismatch');

    const { violations } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});
