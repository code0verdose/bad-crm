import { Badge, Table, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { ProjectModel, type ProjectLib } from '@units/project';

export interface ProjectTeamCardProps {
  readonly rows: readonly ProjectLib.ProjectRosterRow[];
}

/**
 * Who is on the project, as what, and with how much of their time (STORY-014-05, acceptance 4:
 * «состав команды с ролями и загрузкой»). Read-only: putting somebody on the project is the members
 * section (STORY-014-02 client half), and a control that cannot work is not drawn.
 */
export function ProjectTeamCard({ rows }: ProjectTeamCardProps) {
  const { t } = useTranslation();

  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('projects.team.column.person')}</Table.Th>
          <Table.Th scope="col">{t('projects.team.column.role')}</Table.Th>
          <Table.Th scope="col">{t('projects.team.column.allocation')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.userId}>
            <Table.Td>
              <Text size="sm">{row.label}</Text>
            </Table.Td>
            <Table.Td>
              <Badge variant={row.projectRole === 'LEAD' ? 'filled' : 'light'}>
                {t(ProjectModel.PROJECT_ROLE_LABEL[row.projectRole])}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{t('projects.team.allocation', { percent: row.allocationPct })}</Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
