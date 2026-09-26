import { Badge, Group, Table } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { ProjectModel, ProjectUi, type ProjectApi, type ProjectLib } from '@units/project';

import classes from './project-list-ui.module.css';

export interface ProjectTableProps {
  readonly rows: readonly ProjectLib.ProjectListRow<ProjectApi.ProjectListItem>[];
  /** The accessible name of the table — the same words as the view it is. */
  readonly label: string;
}

/**
 * The page as rows — the dense view, for comparing many projects at once.
 *
 * **Presentational**, and with the same columns at every permission level: the item carries no
 * financial field, so there is no column to withhold (acceptance 6). The status reads as a word and
 * an icon, like on the cards (acceptance 11).
 */
export function ProjectTable({ rows, label }: ProjectTableProps) {
  const { t } = useTranslation();

  return (
    <Table aria-label={label} highlightOnHover striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">{t('projects.list.column.project')}</Table.Th>
          <Table.Th scope="col">{t('projects.list.column.key')}</Table.Th>
          <Table.Th scope="col">{t('projects.list.column.status')}</Table.Th>
          <Table.Th scope="col">{t('projects.list.column.lead')}</Table.Th>
          <Table.Th scope="col">{t('projects.list.column.members')}</Table.Th>
          <Table.Th scope="col">{t('projects.list.column.visibility')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.id}>
            <Table.Td>
              <Group gap="xs" wrap="nowrap">
                <ProjectUi.ProjectColorSwatch color={row.color} />
                <Link
                  className={classes['projectLink']}
                  params={{ projectId: row.id }}
                  to="/projects/$projectId"
                >
                  {row.name}
                </Link>
              </Group>
            </Table.Td>
            <Table.Td>
              <Badge variant="outline">{row.key}</Badge>
            </Table.Td>
            <Table.Td>
              <ProjectUi.ProjectStatusBadge status={row.status} />
            </Table.Td>
            <Table.Td>{row.leadLabel}</Table.Td>
            <Table.Td>{row.memberCount}</Table.Td>
            <Table.Td>{t(ProjectModel.PROJECT_VISIBILITY_LABEL[row.visibility])}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
