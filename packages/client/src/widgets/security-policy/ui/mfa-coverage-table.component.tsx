import { Badge, Group, Table, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { OrganizationLib, OrganizationModel, type OrganizationApi } from '@units/organization';

export interface MfaCoverageTableProps {
  readonly rows: readonly OrganizationApi.MfaCoverageRow[];
  /** The moment a deadline is measured from. A parameter so a test can state one. */
  readonly now: Date;
}

/**
 * Everybody, with the verdict the policy in force gives them (acceptance 9).
 *
 * **Presentational**: handed the rows, renders them. It sorts nothing, filters nothing and hides
 * nothing — the narrowing is the URL's and belongs to the unit that owns it
 * (`rules/lists-and-filters.mdc`).
 *
 * **The verdict is a word and a colour, never a colour alone** (`rules/a11y.mdc` §2): a badge whose
 * only difference is red or grey is a table half of an audience cannot read.
 *
 * **The deadline is relative, with the exact moment one hover away.** `RelativeTime` renders a
 * `<time>` carrying the machine-readable instant, which is what keeps «in 6 days» safe to show to a
 * team spread over three time zones. A row without one prints a dash rather than an empty cell: an
 * empty cell reads as missing data, and «no deadline» is a fact.
 */
export function MfaCoverageTable({ rows, now }: MfaCoverageTableProps) {
  const { t } = useTranslation();

  return (
    <Table highlightOnHover striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('organization.security.coverage.column.person')}</Table.Th>
          <Table.Th scope="col">{t('organization.security.coverage.column.roles')}</Table.Th>
          <Table.Th scope="col">{t('organization.security.coverage.column.status')}</Table.Th>
          <Table.Th scope="col">{t('organization.security.coverage.column.deadline')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.userId}>
            <Table.Td>
              <Text size="sm">{row.email}</Text>
            </Table.Td>
            <Table.Td>
              <Group gap="xs" wrap="wrap">
                {OrganizationLib.policyRoleOptions(row.roleKeys, t).map((role) => (
                  <Badge key={role.value} size="sm" variant="default">
                    {role.label}
                  </Badge>
                ))}
              </Group>
            </Table.Td>
            <Table.Td>
              <Badge color={OrganizationModel.MFA_GATE_COLOR[row.gate]} size="sm" variant="light">
                {t(OrganizationModel.MFA_GATE_LABEL[row.gate])}
              </Badge>
            </Table.Td>
            <Table.Td>
              {row.graceEndsAt === undefined ? (
                <Text size="sm">{t('organization.security.coverage.noDeadline')}</Text>
              ) : (
                <Text size="sm">
                  <SharedUi.RelativeTime iso={row.graceEndsAt} now={now} />
                </Text>
              )}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
