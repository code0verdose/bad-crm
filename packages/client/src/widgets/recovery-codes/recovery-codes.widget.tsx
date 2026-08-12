import { Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { AuthUi, type AuthService } from '@units/auth';

import { RecoveryCodesLowBanner } from './ui/recovery-codes-low-banner.component.js';

export interface RecoveryCodesProps {
  /**
   * The controller, owned by the page for the same reason the enrolment one is: a reissue answers
   * with ten codes, and a widget that owned that mutation would be free to unmount them.
   */
  readonly codes: AuthService.RecoveryCodes;
}

/**
 * What is left of the way back in, and how to renew it.
 *
 * The counter reads «unused of issued» rather than as a bare number, because the number on its own
 * is unreadable: «3» means nothing without «of 10» beside it, and the distance between the two is
 * the whole content of the warning underneath.
 *
 * **Two sections side by side, not one nested in the other.** Both are `h2` under the page's single
 * `h1`, which is the outline a reader navigating by headings actually gets; nesting one `Section`
 * inside another would render an `h2` inside an `h2` and claim a hierarchy the markup cannot
 * express (`rules/design-system.mdc` §14).
 *
 * The reissue form is not hidden behind a disclosure. It is the documented way out of a lost
 * enrolment answer — the case where somebody's 2FA is on and they have never seen a code — and
 * somebody in that position is following a sentence that told them to come here.
 */
export function RecoveryCodes({ codes }: RecoveryCodesProps) {
  const { t } = useTranslation();

  return (
    <>
      <SharedUi.Section descriptionKey="security.codes.description" titleKey="security.codes.title">
        <Stack gap="md">
          <Text>
            {t('security.codes.remaining', { remaining: codes.remaining, total: codes.total })}
          </Text>
          {codes.isLow && <RecoveryCodesLowBanner remaining={codes.remaining} />}
        </Stack>
      </SharedUi.Section>

      <SharedUi.Section
        descriptionKey="security.codes.regenerate.description"
        titleKey="security.codes.regenerate.title"
      >
        <AuthUi.RegenerateRecoveryCodesForm
          failureKey={codes.failureKey}
          isPending={codes.isRegenerating}
          onSubmit={codes.regenerate}
        />
      </SharedUi.Section>
    </>
  );
}
