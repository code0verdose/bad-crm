import { Button, Group, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { PublicScreen } from '@widgets/public-screen';
import { TotpSetup } from '@widgets/totp-setup';
import { AuthService, AuthUi } from '@units/auth';

/**
 * `/mfa-enrolment` — where a session the organization's second-factor policy has scoped is sent,
 * and the only screen it can open (STORY-013-05 acceptance 3, STORY-013-04 acceptance 8).
 *
 * Composition only (`rules/frontend-fsd.mdc` rule 7); three of the arrangements are decisions.
 *
 * **The same wizard as `/settings/security`, not a second one.** `widgets/totp-setup` already draws
 * enrolment in all three of its faces and is the thing STORY-013-01 shipped; a copy here would be a
 * second place for every future change to the QR, the warnings or the confirmation form to be
 * forgotten.
 *
 * **`isEnrolled` comes from the hook, not from the counter.** On `/settings/security` that flag is
 * read from `GET /auth/2fa/recovery-codes`; here that route is **not** on the server's three-route
 * whitelist for a scoped session and would answer 403 `mfa_enrollment_required`. It starts `false` —
 * a session that had a second factor would not be on this screen — and the hook turns it on for the
 * window between «I have saved the codes» and the guard carrying the person away, so the wizard says
 * «it is on» instead of offering to turn on what is already on.
 *
 * **No shell.** Every entry in the navigation opens a route the server refuses to this session, so
 * drawing it would be an invitation to collect 403s. `PublicScreen` is the shell-less frame, and it
 * carries the language switch — which matters more here than on most screens: this is the one page
 * somebody can be held on, and being unable to read it is not a state to leave them in.
 *
 * **Signing out is offered, and it is the only other thing the server allows** — `POST /auth/logout`
 * is one of the three whitelisted routes, precisely so that «not now» is an available answer.
 */
export function MfaEnrolmentPage() {
  const { t } = useTranslation();

  const { enrolment, isEnrolled, finish } = AuthService.useMfaEnrolment();
  const logout = AuthService.useLogout();

  return (
    <PublicScreen>
      <SharedUi.PageHeader titleKey="security.enrolment.title" />

      <Text>{t('security.enrolment.reason')}</Text>

      <TotpSetup enrolment={enrolment} isEnrolled={isEnrolled} />

      {/* A `Group` so the button keeps its own width: a `Stack` stretches its children. */}
      <Stack gap="md">
        <Group>
          <Button loading={logout.isPending} onClick={logout.signOut} variant="default">
            {t('security.enrolment.signOut')}
          </Button>
        </Group>
      </Stack>

      {enrolment.issuedCodes !== undefined && (
        <AuthUi.RecoveryCodesDialog codes={enrolment.issuedCodes} onConfirmed={finish} />
      )}
    </PublicScreen>
  );
}
