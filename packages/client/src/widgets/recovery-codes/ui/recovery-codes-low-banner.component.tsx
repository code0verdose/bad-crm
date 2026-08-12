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
 * - **None left.** No longer a warning but a statement of position: recovery-code sign-in is over,
 *   the authenticator is the only way in, and there is no administrator reset on this build to fall
 *   back on. Softening that into «you have 0 codes» would leave somebody believing there is still a
 *   list to find.
 *
 * It is a permanent banner rather than a toast: it describes a condition, not an event, and it is
 * still true on the next page load (`rules/errors-and-toasts.mdc` §5).
 */
export function RecoveryCodesLowBanner({ remaining }: RecoveryCodesLowBannerProps) {
  const { t } = useTranslation();

  if (remaining === 0) {
    return (
      <Alert color="red" role="status" title={t('security.codes.none.title')} variant="light">
        <Text size="sm">{t('security.codes.none.description')}</Text>
      </Alert>
    );
  }

  return (
    <Alert color="yellow" role="status" title={t('security.codes.low.title')} variant="light">
      <Text size="sm">{t('security.codes.low.description', { count: remaining })}</Text>
    </Alert>
  );
}
