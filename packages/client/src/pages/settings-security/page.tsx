import { Stack } from '@mantine/core';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { RecoveryCodes } from '@widgets/recovery-codes';
import { TotpSetup } from '@widgets/totp-setup';
import { AuthService, AuthUi } from '@units/auth';

/**
 * `/settings/security` — the second factor and the way back in.
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

      <SharedUi.DataState
        errorMessageKey="security.loadFailed"
        onRetry={codes.retry}
        skeleton={<SharedUi.TextSkeleton lines={6} />}
        status={codes.status}
      >
        <Stack gap="md">
          <TotpSetup enrolment={enrolment} isEnrolled={codes.isEnrolled} />
          {codes.isEnrolled && <RecoveryCodes codes={codes} />}
        </Stack>
      </SharedUi.DataState>

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
