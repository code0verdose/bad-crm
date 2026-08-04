import { Anchor } from '@mantine/core';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';

import { SharedUi } from '@shared';

import { PublicScreen } from '@widgets/public-screen';
import { AuthService, AuthUi } from '@units/auth';

/**
 * `getRouteApi`, not an import of the route file: a page may not import from `app/`
 * (`rules/frontend-fsd.mdc` rule 1), and this gives the same typed `useParams` through the
 * registered route tree instead of through a dependency pointing the wrong way.
 */
const route = getRouteApi('/reset-password/$token');

/**
 * `/reset-password/$token` — the screen the mailed link opens.
 *
 * Composition only (`rules/frontend-fsd.mdc` rule 7). The token comes from the path, goes into the
 * hook, and leaves in a request body; nothing renders it and nothing puts it in a query string
 * (`docs/security/threat-model.md`, T-IAM-07).
 *
 * **No guard.** A signed-in visitor may hold a reset link too — that is what following one from a
 * mail on a second device looks like — and the token is the credential this route runs on, not the
 * session. Success revokes every session of the account, this tab's included, which is why the page
 * ends at `/login`: the server issues no tokens on a reset, so there is nothing here to be signed in
 * with.
 *
 * **The link to ask for a new mail is on the page before anything fails.** Unknown, spent and
 * expired tokens are one refusal by design, and it arrives as a red toast from the global
 * `MutationCache` handler (`rules/errors-and-toasts.mdc` §3). Rendering a second, inline copy of
 * that message would be two signals for one action; what a person actually needs after it is the
 * way to start again, and that is useful whether or not anything has failed yet.
 */
export function ResetPasswordPage() {
  const { token } = route.useParams();
  const navigate = useNavigate();

  const reset = AuthService.useConfirmPasswordReset({
    token,
    onDone: () => {
      void navigate({ to: '/login', replace: true });
    },
  });

  return (
    <PublicScreen>
      <SharedUi.PageHeader titleKey="auth.resetPassword.title" />

      <AuthUi.ResetPasswordForm isPending={reset.isPending} onSubmit={reset.submit} />

      <Anchor component={Link} to="/forgot-password">
        auth.resetPassword.requestNewLink
      </Anchor>
    </PublicScreen>
  );
}
