import { Alert, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

export interface RecoveryCodesLowBannerProps {
  readonly remaining: number;
}

/**
 * The standing warning that the way back is running out (STORY-013-02, acceptance 6).
 *
 * Two sentences, not one, because the two situations are genuinely different:
 *
 * - **Some left.** A count, and an instruction to replace the set while replacing it is still
 *   something this person can do on their own — it needs a live code from the authenticator, so it
 *   has to happen before the phone is the problem.
 * - **None left.** No longer a warning but a statement of position: recovery-code sign-in is over
 *   and the authenticator is the only way in that this person controls. The string names the one
 *   remaining exit rather than pretending there is none — an administrator holding `user:reset_mfa`
 *   can strip the second factor (`widgets/reset-mfa` on the employee profile) — and it names it
 *   last, after «issue a new set below while it still works», because the reset costs somebody
 *   else's time and the self-service path is still open at this moment. Softening the position into
 *   «you have 0 codes» would leave somebody believing there is still a list to find.
 *
 * It is a permanent banner rather than a toast: it describes a condition, not an event, and it is
 * still true on the next page load (`rules/errors-and-toasts.mdc` §5).
 */
export function RecoveryCodesLowBanner({ remaining }: RecoveryCodesLowBannerProps) {
  const { t } = useTranslation();

  if (remaining === 0) {
    return (
      <Alert color="danger" role="status" title={t('security.codes.none.title')} variant="light">
        <Text size="sm">{t('security.codes.none.description')}</Text>
      </Alert>
    );
  }

  return (
    <Alert color="warning" role="status" title={t('security.codes.low.title')} variant="light">
      <Text size="sm">{t('security.codes.low.description', { count: remaining })}</Text>
    </Alert>
  );
}
