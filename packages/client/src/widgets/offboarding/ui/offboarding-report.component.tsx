import { Alert, List, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { type EmployeeApi } from '@units/employee';

export interface OffboardingReportProps {
  readonly report: EmployeeApi.OffboardingReport;
}

/**
 * Written out rather than composed from the value. ADR-0019 forbids assembling a key at runtime: a
 * key built from the step name cannot be found by reading the source, and the parity gate would
 * report four translated strings as zero used ones.
 */
const PENDING_KEYS = {
  projectsLeft: 'offboarding.pending.projectsLeft',
  socketsClosed: 'offboarding.pending.socketsClosed',
  linksRevoked: 'offboarding.pending.linksRevoked',
  vaultMembershipsFlagged: 'offboarding.pending.vaultMembershipsFlagged',
} as const;

/**
 * What the offboarding actually did — and what it could not reach.
 *
 * The second half is the point. A report that listed only the counters would read as complete, and
 * «кажется, всё отключили» is precisely what this operation exists to replace: the steps no
 * subsystem exists for yet are shown as a warning, not omitted and not rendered as zero.
 *
 * **A repeat run says so instead of showing zeroes.** The use-case calls running an offboarding
 * twice ordinary — «often run twice, by two people» — and answers the second one with
 * `alreadyDeactivated: true` and both counters at nought. Rendering those would print «Отозвано
 * сессий: 0 / Покинуто команд: 0», which is indistinguishable from a real run that found nothing to
 * revoke: the same false reassurance the `pending` list exists to prevent, one field further along.
 */
export function OffboardingReport({ report }: OffboardingReportProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="sm">
      {report.alreadyDeactivated ? (
        <Alert color="blue" title={t('offboarding.already.title')} variant="light">
          <Text size="sm">{t('offboarding.already.description')}</Text>
        </Alert>
      ) : (
        <>
          <Text>{t('offboarding.done.sessions', { count: report.sessionsRevoked })}</Text>
          <Text>{t('offboarding.done.teams', { count: report.teamsLeft })}</Text>
        </>
      )}

      {report.pending.length > 0 && (
        <Alert color="yellow" title={t('offboarding.pending.title')}>
          <Text size="sm">{t('offboarding.pending.description')}</Text>
          <List size="sm">
            {report.pending.map((step) => (
              <List.Item key={step}>{t(PENDING_KEYS[step])}</List.Item>
            ))}
          </List>
        </Alert>
      )}
    </Stack>
  );
}
