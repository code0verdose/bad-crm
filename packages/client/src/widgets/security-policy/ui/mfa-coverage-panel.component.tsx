import { Button, Group, MultiSelect, Stack, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { OrganizationLib, OrganizationModel, OrganizationService } from '@units/organization';

import { MfaCoverageTable } from './mfa-coverage-table.component.js';

export interface MfaCoveragePanelProps {
  readonly search: OrganizationModel.OrganizationSettingsSearch;
  readonly navigate: OrganizationService.OrganizationHooks.CoverageSearchNavigation;
  /** The moment a deadline is measured from. A parameter so a test can state one. */
  readonly now: Date;
}

/**
 * Who has a second factor and who has not, narrowed by the URL (acceptance 9).
 *
 * **The filters are the address bar and nothing else** (`rules/lists-and-filters.mdc` §1): the
 * phrase is debounced before it is written, both selects write immediately, and every write is
 * `replace` so that six keystrokes are not six entries in the history. All of that lives in
 * `useCoverageFilters`; this component holds no state at all.
 *
 * **«Nothing matches» is not «nobody is here».** The two produce the same empty table and mean
 * opposite things — one is a filter to clear, the other is an organization with no accounts — so
 * they are different sentences, chosen from the unfiltered count.
 *
 * The reminder of acceptance 9 — «send this person a nudge» — is **not** here. There is no endpoint
 * behind it (STORY-013-05, «Осталось»), and a button that reports success while sending nothing is
 * worse than the absence of one.
 */
export function MfaCoveragePanel({ search, navigate, now }: MfaCoveragePanelProps) {
  const { t } = useTranslation();
  const coverage = OrganizationService.OrganizationHooks.useMfaCoverage(search, navigate);

  return (
    <Stack gap="md">
      <Group align="end" gap="md" wrap="wrap">
        <TextInput
          label={t('organization.security.coverage.searchLabel')}
          onChange={(event) => {
            coverage.filters.setQuery(event.currentTarget.value);
          }}
          placeholder={t('organization.security.coverage.searchPlaceholder')}
          value={coverage.filters.typed}
        />
        <MultiSelect
          data={[...OrganizationLib.policyRoleOptions(coverage.roleOptions, t)]}
          label={t('organization.security.coverage.roleLabel')}
          onChange={coverage.filters.setRoles}
          value={[...search.role]}
        />
        <MultiSelect
          data={OrganizationModel.MFA_GATES.map((gate) => ({
            value: gate,
            label: t(OrganizationModel.MFA_GATE_LABEL[gate]),
          }))}
          label={t('organization.security.coverage.gateLabel')}
          onChange={coverage.filters.setGates}
          value={[...search.gate]}
        />
        {coverage.filters.isFiltered && (
          <Button onClick={coverage.filters.reset} variant="default">
            {t('organization.security.coverage.reset')}
          </Button>
        )}
      </Group>

      <SharedUi.DataState
        errorMessageKey="organization.security.coverage.loadFailed"
        onRetry={coverage.refetch}
        skeleton={<SharedUi.TextSkeleton lines={4} />}
        status={coverage.status}
      >
        <Stack gap="sm">
          {/* Announced: the numbers are what changes when a filter is applied, and a screen reader
              is otherwise told nothing about a table that has just been narrowed
              (`rules/a11y.mdc` §13). */}
          <Text role="status" size="sm">
            {t('organization.security.coverage.summary', {
              covered: coverage.covered,
              enrolled: coverage.enrolled,
            })}{' '}
            {t('organization.security.coverage.shown', {
              shown: coverage.rows.length,
              total: coverage.total,
            })}
          </Text>

          {coverage.rows.length === 0 ? (
            <Text size="sm">
              {coverage.total === 0
                ? t('organization.security.coverage.empty')
                : t('organization.security.coverage.noMatches')}
            </Text>
          ) : (
            <MfaCoverageTable now={now} rows={coverage.rows} />
          )}
        </Stack>
      </SharedUi.DataState>
    </Stack>
  );
}
