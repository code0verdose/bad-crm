import { Anchor } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';

import { SharedUi } from '@shared';

import { PublicScreen } from '@widgets/public-screen';
import { AuthService, AuthUi } from '@units/auth';

/**
 * The public entry point: a heading, a form, the way to recovery, and nothing that knows about the
 * network (`rules/frontend-fsd.mdc` rule 7).
 *
 * **It does not navigate.** Where a session lands is decided once, by `redirectIfAuthed` on this
 * route: signing in records the session and asks the router to re-check its guards, and the guard
 * carries the user to `search.redirect` — the page they were going to when `requireSession`
 * intercepted them, or `/dashboard`. A page that navigated on success would race that guard, and
 * whichever won would pick the destination.
 *
 * The link to `/forgot-password` is what makes the recovery screen reachable by anybody who is not
 * already holding a mail — this is the only screen a person who cannot sign in ever looks at.
 *
 * The centring and the `main` landmark come from `SharedUi.CenteredScreen`, shared with the two
 * recovery screens: the public branch has no `AppShell.Main` to be the landmark, and content that
 * sits in no landmark at all is an `axe` violation and a screen reader with nowhere to jump
 * (`rules/a11y.mdc` §20).
 *
 * **Two steps, one route** (STORY-013-03, acceptance 11). The second factor is not a page of its
 * own and must not become one: the step is held together by an intermediate token that lives five
 * minutes in memory, and a URL for it would be a URL that survives a reload with nothing behind it
 * — or, worse, a URL somebody could be invited to carry the token in. Which step is on screen is
 * decided by the unit hook and swapped in place; the heading changes with it, so what the page is
 * about is announced by the route announcer rather than left saying «Sign in» over a form that asks
 * for a code.
 *
 * The way to `/forgot-password` belongs to the password step only. On the second step the password
 * has already been accepted, and offering to reset it there would invite somebody to abandon a
 * sign-in that is one code from finishing.
 */
export function LoginPage() {
  const { t } = useTranslation();

  const login = AuthService.useLogin();

  return (
    <PublicScreen>
      <SharedUi.PageHeader
        titleKey={login.step === 'password' ? 'auth.login.title' : 'auth.twoFactor.title'}
      />

      {login.step === 'password' ? (
        <>
          <AuthUi.LoginForm
            isPending={login.isPending}
            notice={login.notice}
            onSubmit={login.submit}
          />

          <Anchor component={Link} to="/forgot-password">
            {t('auth.login.forgotPassword')}
          </Anchor>
        </>
      ) : (
        <AuthUi.TwoFactorForm
          failure={login.secondFactor.failure}
          isPending={login.secondFactor.isPending}
          onSubmit={login.secondFactor.submit}
          secondsLeft={login.secondFactor.secondsLeft}
        />
      )}
    </PublicScreen>
  );
}
