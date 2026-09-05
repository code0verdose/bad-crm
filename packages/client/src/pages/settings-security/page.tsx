import { Stack } from '@mantine/core';

import { SharedUi } from '@shared';

import { ActiveSessions } from '@widgets/active-sessions';
import { Breadcrumbs } from '@widgets/breadcrumbs';
import { ChangePassword } from '@widgets/change-password';
import { DisableTotp } from '@widgets/disable-totp';
import { RecoveryCodes } from '@widgets/recovery-codes';
import { TotpSetup } from '@widgets/totp-setup';
import { AuthService, AuthUi } from '@units/auth';

/**
 * `/settings/security` — the password, the second factor, the way back in, and where the account is
 * signed in.
 *
 * The order is the reading order it deserves: the credential itself, then the credential that backs
 * it up, then the places both are currently in use and the way to cut them off. Only the middle
 * group is drawn from the recovery-code counter, and only the middle group is inside the `DataState`
 * that reads it — the first and last sections each own their own state, so one failed read cannot
 * take the others off a screen somebody opened because something had gone wrong.
 *
 * Composition only (`rules/frontend-fsd.mdc` rule 7), but two of the arrangements below are
 * decisions rather than layout:
 *
 * **The page owns both controllers.** Enrolling and reissuing each answer with ten recovery codes
 * that exist in no other form, and each of them changes what the screen shows about itself. A
 * widget that owned its own mutation would be unmounted by its own success, taking the only copy of
 * ten credentials with it. Held here, they outlive every swap below.
 *
 * **The dialog sits outside `DataState`.** The codes are shown by a dialog fed from whichever
 * controller has just produced a set; keeping it under the counter's loading state would let a
 * background refetch — or a failed one — take it off the screen mid-read. Nothing about the counter
 * is allowed to reach the ten codes.
 *
 * What decides «enrolled» is the recovery-code counter, because no operation in the contract reports
 * enrolment state — the reasoning, and the gap, are written out in
 * `units/auth/service/queries/recovery-code-status.query.ts`.
 */
export function SettingsSecurityPage() {
  const codes = AuthService.useRecoveryCodes();
  const enrolment = AuthService.useTotpEnrolment();

  /**
   * Whichever set was just issued — at most one exists, because only one of the two operations can
   * have run last, and each drops its own the moment the person confirms they have saved it.
   */
  const issued = enrolment.issuedCodes ?? codes.issuedCodes;

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="security.title" />

      {/*
        First, and outside the counter's `DataState` below. The password is the credential everything
        else on this screen protects, and the sections under it are drawn from a read that can fail —
        wrapping the form in that state would take away the ability to change a password because a
        recovery-code counter did not load, on the screen somebody opens when they think the password
        has leaked.
      */}
      <ChangePassword />

      <SharedUi.DataState
        errorMessageKey="security.loadFailed"
        onRetry={codes.retry}
        skeleton={<SharedUi.TextSkeleton lines={6} />}
        status={codes.status}
      >
        <Stack gap="md">
          <TotpSetup enrolment={enrolment} isEnrolled={codes.isEnrolled} />
          {codes.isEnrolled && <RecoveryCodes codes={codes} />}
          {/*
            Last, and only while there is something to switch off. The order is the argument: every
            section above is about keeping the second factor usable, and the one that destroys it
            comes after them rather than beside «it is on» (`rules/design-system.mdc` §17).
          */}
          {codes.isEnrolled && <DisableTotp />}
        </Stack>
      </SharedUi.DataState>

      {/*
        Last, and outside the counter's `DataState` for the same reason the password form is outside
        it: this section has a read of its own, and a failure of one must not take the other off the
        screen. It comes after the second-factor sections because it is not a setting — it is the
        state those settings produce, and the place to cut it off.
      */}
      <ActiveSessions />

      {issued !== undefined && (
        <AuthUi.RecoveryCodesDialog
          codes={issued}
          onConfirmed={() => {
            enrolment.dismissCodes();
            codes.dismissCodes();
          }}
        />
      )}
    </Stack>
  );
}
