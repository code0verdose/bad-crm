import { Button, Group, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { AuthUi, type AuthService } from '@units/auth';

import { TotpLockoutWarnings } from './ui/totp-lockout-warnings.component.js';

export interface TotpSetupProps {
  /**
   * The enrolment controller, owned by the page rather than by this widget.
   *
   * That is not a style preference. Confirming enrolment makes the counter behind the screen say
   * «enrolled», which changes what this widget draws — and the ten recovery codes live in the very
   * mutation this widget would otherwise have owned. Owned here, they would be unmounted by their
   * own success, and the only copy of ten credentials would vanish at the instant it was produced.
   */
  readonly enrolment: AuthService.TotpEnrolment;
  /** Decided by the recovery-code counter — see `recovery-code-status.query.ts` for why. */
  readonly isEnrolled: boolean;
}

/**
 * The state of the second factor, in three faces: off, mid-enrolment, on.
 *
 * The face is derived at render from what the controller holds and never mirrored into state
 * (`rules/frontend-fsd.mdc` rule 11) — a copy would be a second answer to «which step is this», and
 * the two would disagree the moment a request failed.
 *
 * **Mid-enrolment outranks «on»**, and that ordering is load-bearing rather than incidental: the
 * moment a confirmation succeeds the counter behind the screen starts saying «enrolled», while the
 * ten codes are still on screen in a dialog whose trigger is the confirm button in this face.
 * Letting «on» win at that instant would tear the trigger out from under an open dialog.
 *
 * A refusal of the *draft* — `409 mfa_already_enabled`, `429` — is not rendered here: it is the one
 * global toast, because it means «the button did nothing» and there is no field for it to sit
 * beside. A refusal of the *confirmation* is rendered in the form, because it is about the two
 * values on screen and because it carries the sentence that tells somebody who lost the answer
 * where to go (`rules/errors-and-toasts.mdc` §2–§3).
 */
export function TotpSetup({ enrolment, isEnrolled }: TotpSetupProps) {
  const { t } = useTranslation();
  const isDrafting = enrolment.draft !== undefined;

  return (
    <SharedUi.Section titleKey="security.totp.title">
      {enrolment.draft !== undefined && (
        <Stack gap="md">
          <Text>{t('security.totp.scan.description')}</Text>
          <AuthUi.TotpQr qrSvg={enrolment.draft.qrSvg} secret={enrolment.draft.secret} />
          <AuthUi.TotpConfirmForm
            failureKey={enrolment.failureKey}
            isPending={enrolment.isConfirming}
            onCancel={enrolment.abandon}
            onSubmit={enrolment.confirm}
          />
        </Stack>
      )}

      {!isDrafting && isEnrolled && (
        <Stack gap="md">
          <Text>{t('security.totp.status.on')}</Text>
          {/*
            The same three warnings, still true and still worth reading once 2FA is on: there is no
            way to switch it off on this build, and the recovery codes below are the only way back.
            Hiding them after enrolment would leave the person who most needs them — the one who now
            depends on an authenticator app — with no statement of what they depend on.
          */}
          <TotpLockoutWarnings />
        </Stack>
      )}

      {!isDrafting && !isEnrolled && (
        <Stack gap="md">
          <Text>{t('security.totp.description')}</Text>
          <TotpLockoutWarnings />
          {/* A `Group` so the button keeps its own width: a `Stack` stretches its children. */}
          <Group>
            <Button loading={enrolment.isBeginning} onClick={enrolment.begin}>
              {t('security.totp.enable')}
            </Button>
          </Group>
        </Stack>
      )}
    </SharedUi.Section>
  );
}
