import { Alert, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { type EmployeeApi } from '@units/employee';

export interface ResetMfaReportProps {
  readonly result: EmployeeApi.ResetMfaResult;
}

/**
 * What the reset actually did — and, when it did nothing, that it did nothing.
 *
 * **The `wasEnabled: false` branch is the point of this component.** The client cannot know whether
 * a colleague has a second factor: no document in the contract carries enrolment state, so the
 * button is offered on every record and «reset somebody who never had one» is an ordinary outcome
 * rather than an edge case. The server treats that call as a genuine no-op — no session revoked, no
 * recovery code batch to delete, no permission version bumped, no mail sent — and rendering the
 * counters it returns would print «Recovery codes deleted: 0 / Sessions revoked: 0», which reads as
 * a report about the reset rather than about this run. That is the same false reassurance
 * `OffboardingReport` refuses to give for `alreadyDeactivated`, one operation further along.
 *
 * **The counters are shown rather than a word like «done»**, for the reason
 * `DeactivateUserUseCase` puts them in its response at all: a destructive operation whose answer
 * carries no numbers is one the administrator has to trust instead of check. Seven codes destroyed
 * and three devices signed out is a different fact from one and none, and only one of the two is
 * worth a phone call to the person it happened to.
 *
 * **And what happens next is said here**, because it is the half an administrator would otherwise
 * assume: this removes a second factor, it does not set one up. Nobody's account is protected again
 * until its owner enrols, which only its owner can do.
 */
export function ResetMfaReport({ result }: ResetMfaReportProps) {
  const { t } = useTranslation();

  if (!result.wasEnabled) {
    return (
      <Alert color="info" title={t('security.reset.already.title')} variant="light">
        <Text size="sm">{t('security.reset.already.description')}</Text>
      </Alert>
    );
  }

  return (
    <Stack gap="sm">
      <Text fw={600}>{t('security.reset.done.title')}</Text>
      <Text>{t('security.reset.done.codes', { count: result.recoveryCodesDeleted })}</Text>
      <Text>{t('security.reset.done.sessions', { count: result.sessionsRevoked })}</Text>
      {/* Titleless on purpose: the sentence *is* the heading, and an `Alert` with both would say
          the same thing twice to a screen reader that reads the title and then the body. */}
      <Alert color="warning" variant="light">
        <Text size="sm">{t('security.reset.done.next')}</Text>
      </Alert>
    </Stack>
  );
}
