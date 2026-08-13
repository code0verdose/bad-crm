import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

import { TwoFactorForm } from '@units/auth/ui';

/**
 * The second step of the sign-in, as somebody with no mouse and no authenticator meets it.
 *
 * Everything asserted here is load-bearing without a pointer and invisible in a screenshot: the
 * field a phone can fill from a notification, the focus that lands on it the moment the step
 * appears, the way to a recovery code for the person whose phone is gone, the countdown that says
 * how long the step has, and a refusal that is *announced* rather than merely drawn
 * (`rules/a11y.mdc` §13, §18).
 */
const renderForm = (props: Partial<Parameters<typeof TwoFactorForm>[0]> = {}) => {
  const onSubmit = vi.fn();

  const { container } = render(
    <MantineProvider env="test">
      <TwoFactorForm
        failureKey={undefined}
        isPending={false}
        onSubmit={onSubmit}
        secondsLeft={287}
        {...props}
      />
    </MantineProvider>,
  );

  return { container, onSubmit, user: userEvent.setup() };
};

const codeField = () => screen.getByLabelText(/auth\.twoFactor\.code\.label/);

describe('the second-factor step', () => {
  it('hands the code over when there is one to hand over', async () => {
    const { onSubmit, user } = renderForm();

    await user.type(codeField(), '123456');
    await user.click(screen.getByRole('button', { name: 'auth.twoFactor.submit' }));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ code: '123456' });
  });

  /**
   * `one-time-code` is what makes a phone offer the code straight from the notification instead of
   * making somebody memorise six digits and switch apps twice — the acceptance criterion names the
   * attribute itself, so it is asserted as an attribute.
   */
  it('asks the platform for the one-time code', () => {
    renderForm();

    expect(codeField()).toHaveAttribute('autocomplete', 'one-time-code');
  });

  /**
   * The step replaces the password form in place, so nothing else moves the caret. Without this, a
   * screen-reader user is left on a submit button that no longer exists and hears nothing about a
   * form that just appeared.
   */
  it('puts the focus on the code field as soon as it appears', async () => {
    renderForm();

    await waitFor(() => {
      expect(document.activeElement).toBe(codeField());
    });
  });

  it('can be filled in and submitted with the keyboard alone', async () => {
    const { onSubmit, user } = renderForm();

    await user.keyboard('123456');
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ code: '123456' });
  });

  it('refuses to send an empty code, and says so under the field', async () => {
    const { onSubmit, user } = renderForm();

    await user.click(screen.getByRole('button', { name: 'auth.twoFactor.submit' }));

    expect(await screen.findByText('validation.second_factor.required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(codeField()).toHaveAttribute('aria-invalid', 'true');
  });

  /**
   * That the line is there, and no more than that. This suite runs i18next in `cimode`, where
   * `t(key, values)` answers with the key and drops the interpolation — so `4:47` is not on screen
   * here and asserting it would only ever pass by accident. The number itself is asserted where a
   * real catalogue is loaded: `test/i18n/pseudo-locale.test.tsx`.
   */
  it('says how long the step has left', () => {
    renderForm({ secondsLeft: 287 });

    expect(screen.getByText('auth.twoFactor.expiresIn')).toBeInTheDocument();
  });

  describe('the way in without an authenticator', () => {
    /**
     * The same field, a different hint. The person whose phone is gone has a printed sheet and no
     * six digits — a step that only ever described the app would leave them reading instructions
     * they cannot follow, in front of an input that would accept their code perfectly well.
     */
    it('switches the hint to the recovery code, keeping the one field', async () => {
      const { user } = renderForm();

      expect(screen.getByText('auth.twoFactor.description')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'auth.twoFactor.useRecoveryCode' }));

      expect(screen.getByText('auth.twoFactor.recovery.description')).toBeInTheDocument();
      expect(screen.queryByText('auth.twoFactor.description')).not.toBeInTheDocument();
      expect(screen.getAllByRole('textbox')).toHaveLength(1);
    });

    it('accepts a recovery code, which is neither six characters nor digits', async () => {
      const { onSubmit, user } = renderForm();

      await user.click(screen.getByRole('button', { name: 'auth.twoFactor.useRecoveryCode' }));
      await user.type(codeField(), 'a1b2c-3d4e5-f6g7h');
      await user.click(screen.getByRole('button', { name: 'auth.twoFactor.submit' }));

      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ code: 'a1b2c-3d4e5-f6g7h' });
    });

    it('leads back to the authenticator for whoever clicked by mistake', async () => {
      const { user } = renderForm();

      await user.click(screen.getByRole('button', { name: 'auth.twoFactor.useRecoveryCode' }));
      await user.click(screen.getByRole('button', { name: 'auth.twoFactor.useAuthenticator' }));

      expect(screen.getByText('auth.twoFactor.description')).toBeInTheDocument();
    });

    it('moves the caret to the field it just re-explained', async () => {
      const { user } = renderForm();

      await user.click(screen.getByRole('button', { name: 'auth.twoFactor.useRecoveryCode' }));

      await waitFor(() => {
        expect(document.activeElement).toBe(codeField());
      });
    });
  });

  it('announces a refused code rather than only drawing it', () => {
    renderForm({ failureKey: 'errors.code.mfa_invalid_code' });

    expect(screen.getByRole('alert')).toHaveTextContent('errors.code.mfa_invalid_code');
  });

  it('carries the wait on the submit button, leaving the field readable', () => {
    renderForm({ isPending: true });

    expect(screen.getByRole('button', { name: 'auth.twoFactor.submit' })).toHaveAttribute(
      'data-loading',
      'true',
    );
    expect(codeField()).toBeEnabled();
  });

  it('has no accessibility violation, plain or refused', async () => {
    const { container } = renderForm({ failureKey: 'errors.code.mfa_invalid_code' });

    const { violations } = await axe.run(container, {
      // Colours live in a stylesheet jsdom never loads; contrast is measured from the tokens in
      // `test/theme/tokens.test.ts`, where the real values are.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});
