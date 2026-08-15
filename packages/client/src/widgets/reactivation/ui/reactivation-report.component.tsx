import { Alert, List, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { type EmployeeApi } from '@units/employee';

export interface ReactivationReportProps {
  readonly result: EmployeeApi.ReactivationResult;
}

/**
 * What the reactivation did — and, at greater length, what it deliberately did not.
 *
 * **The second half is the point of this component** (acceptance 4 of STORY-012-09). A report that
 * said «done» and stopped would send an administrator away believing a colleague came back in the
 * state they left in; they came back able to sign in, and nothing else. Teams, projects and shared
 * vaults were left on the way out and stay left, because restoring them would be re-granting access
 * on the strength of a decision that was correct months ago — somebody returning to the same job is
 * added back by a person who decides so today.
 *
 * **`membershipsRestored` is read rather than assumed.** The contract says it is always `false` and
 * explains why; a client that hard-coded the warning would go on printing it on the day that stops
 * being true. Reading the field means the sentence disappears by itself when the server starts
 * bringing memberships back.
 *
 * **A run that changed nothing says so instead of claiming a return.** `alreadyActive: true` is an
 * ordinary outcome here — two tabs, or two administrators looking at the same directory — and the
 * server wrote nothing at all for it. Rendering the success wording would be the same false
 * reassurance `OffboardingReport` refuses to give one operation in the other direction.
 */
export function ReactivationReport({ result }: ReactivationReportProps) {
  const { t } = useTranslation();

  if (result.alreadyActive) {
    return (
      <Alert color="info" title={t('members.reactivate.already.title')} variant="light">
        <Text size="sm">{t('members.reactivate.already.description')}</Text>
      </Alert>
    );
  }

  return (
    <Stack gap="sm">
      <Text fw={600}>{t('members.reactivate.done.title')}</Text>
      <Text>{t('members.reactivate.done.description')}</Text>

      {!result.membershipsRestored && (
        <Alert color="warning" title={t('members.reactivate.notRestored.title')} variant="light">
          <Text size="sm">{t('members.reactivate.notRestored.description')}</Text>
          <List size="sm">
            <List.Item>{t('members.reactivate.limits.teams')}</List.Item>
            <List.Item>{t('members.reactivate.limits.projects')}</List.Item>
            <List.Item>{t('members.reactivate.limits.vaults')}</List.Item>
          </List>
        </Alert>
      )}
    </Stack>
  );
}
