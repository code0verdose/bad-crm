import { Anchor } from '@mantine/core';
import { Link } from '@tanstack/react-router';

import { SharedUi } from '@shared';

import { AuthService, AuthUi } from '@units/auth';

/**
 * `/forgot-password` — the screen for somebody who cannot get past the sign-in form.
 *
 * Composition only (`rules/frontend-fsd.mdc` rule 7): a heading, one of two panels, and the way
 * back. Which panel is the whole of its logic, and it is read from the hook rather than kept in
 * state of its own — the form until the request has been accepted, the constant confirmation
 * afterwards.
 *
 * **The form is replaced rather than joined by a message.** A page that kept the form and added a
 * banner invites a second request for the same address, which is a second mail with a second token
 * for a person who is already looking at their inbox for the first one.
 *
 * The link back to `/login` is not decoration: this route is reachable directly from a mail client
 * and from the sign-in form, and a public screen with no exit is a dead end for anybody who arrived
 * by mistake.
 */
export function ForgotPasswordPage() {
  const request = AuthService.useRequestPasswordReset();

  return (
    <SharedUi.CenteredScreen>
      <SharedUi.PageHeader titleKey="auth.forgotPassword.title" />

      {request.isSent ? (
        <AuthUi.PasswordResetSent />
      ) : (
        <AuthUi.ForgotPasswordForm isPending={request.isPending} onSubmit={request.submit} />
      )}

      <Anchor component={Link} to="/login">
        auth.forgotPassword.backToLogin
      </Anchor>
    </SharedUi.CenteredScreen>
  );
}
