import { Anchor } from '@mantine/core';
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
 */
export function LoginPage() {
  const login = AuthService.useLogin();

  return (
    <PublicScreen>
      <SharedUi.PageHeader titleKey="auth.login.title" />

      <AuthUi.LoginForm
        isPending={login.isPending}
        noticeKey={login.noticeKey}
        onSubmit={login.submit}
      />

      <Anchor component={Link} to="/forgot-password">
        auth.login.forgotPassword
      </Anchor>
    </PublicScreen>
  );
}
