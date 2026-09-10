import { Anchor } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { PublicScreen } from '@widgets/public-screen';
import { AuthService, AuthUi } from '@units/auth';

/**
 * `/register` — the first door of an empty installation: an organization, its owner, and a session.
 *
 * Composition only (`rules/frontend-fsd.mdc` rule 7): a heading, one of two panels, and the way to
 * sign in. Which panel is the whole of its logic, and it is read from the hook rather than kept in
 * state of its own — the form until the installation says it does not accept new organizations, the
 * constant notice afterwards.
 *
 * **It does not navigate.** `POST /auth/register` answers with a session (`AuthenticatedSession`,
 * cookie included), the mutation records it and announces `logged-in`, and `app/auth-events.util.ts`
 * turns that into `router.invalidate()` — at which point `redirectIfAuthed` on this route carries
 * the new owner into the application. A page that navigated on success would race that guard, and
 * whichever won would pick the destination. It is the same arrangement `/login` and `/invite/$token`
 * use, for the same reason.
 *
 * The link to `/login` is not decoration: somebody who already has an account and landed here by
 * following a bookmark needs a way out that is not the browser's back button.
 */
export function RegisterPage() {
  const { t } = useTranslation();

  const registration = AuthService.useRegistration();

  return (
    <PublicScreen>
      <SharedUi.PageHeader titleKey="auth.register.title" />

      {registration.isClosed ? (
        <AuthUi.RegistrationClosed />
      ) : (
        <AuthUi.RegisterForm
          isPending={registration.isPending}
          notice={registration.notice}
          onSubmit={registration.submit}
          passwordError={registration.passwordError}
          slugError={registration.slugError}
        />
      )}

      <Anchor component={Link} to="/login">
        {t('auth.register.backToLogin')}
      </Anchor>
    </PublicScreen>
  );
}
