import { Badge, NativeSelect, Stack, Table, Text } from '@mantine/core';
import { type RefObject, useCallback, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedHooks, SharedLib } from '@shared';

import { type ProjectRosterRow } from '@units/project/lib';
import { PROJECT_ROLE_LABEL, PROJECT_ROLES, type ProjectRole } from '@units/project/model';

import { ArchivedNote } from './archived-note.component.js';
import { ProjectMemberRemove } from './project-member-remove.component.js';

export interface ProjectMemberTableProps {
  readonly rows: readonly ProjectRosterRow[];
  /**
   * Present only for a reader the card's `permissions.canManageMembers` lets through — then each
   * row gets a role select and a remove button. Absent, the table is read-only: a control that
   * cannot work is not drawn (STORY-014-05, acceptance 5).
   */
  readonly onChangeRole?: (userId: string, projectRole: ProjectRole) => void;
  /** `onRemoved` fires once the server has agreed — until then the row may still come back. */
  readonly onRemove?: (userId: string, onRemoved: () => void) => void;
  /**
   * Archived: the controls stay on screen (acceptance 7), reachable and marked unavailable, with a
   * note beside the table saying why — and they do nothing.
   */
  readonly locked?: boolean;
  /**
   * Where focus goes when a role select leaves the page while holding it — a filtered roster drops
   * the row whose role was just changed out of the filter (STORY-014-02, acceptance 10). Without it
   * focus falls to `<body>`.
   */
  readonly returnFocusTo?: RefObject<HTMLElement | null>;
}

/**
 * Who is on the project, as what, and with how much of their time — and, for somebody who may
 * manage the roster, the two in-row commands.
 *
 * Every control carries the person's name in its accessible name: a column of identical «Role» and
 * «Remove» controls is, to a screen reader moving through them, a column of identical controls.
 *
 * **Archived, nothing is hard-`disabled`** (`rules/a11y.mdc` §23): that took every select and button
 * out of the tab order, with the reason in a banner far above. The controls say «unavailable»
 * (`aria-disabled`) and are described by the note above the table — the table carries the
 * description for the selects, because Mantine sets `aria-describedby` on its inputs from their own
 * description and error and overwrites one passed in (`Input.mjs`, 9.5.1). The select keeps the stored
 * role (`value` plus a handler that ignores the pick), the button has no handler at all.
 *
 * **Which removal might come back** is held here, in a ref: set when «Remove» is pressed, cleared when
 * the server agrees. A refused removal is rolled back and the row returns as a new node; its button
 * sees its own id and takes focus again (`ProjectMemberRemove`).
 */
export function ProjectMemberTable({
  rows,
  onChangeRole,
  onRemove,
  locked = false,
  returnFocusTo,
}: ProjectMemberTableProps) {
  const { t, i18n } = useTranslation();
  const noteId = useId();
  const returning = useRef<string | null>(null);
  const noAnchor = useRef<HTMLElement | null>(null);
  const handOffFocus = SharedHooks.useRemovalFocusHandoff(returnFocusTo ?? noAnchor);

  const remove = useCallback(
    (userId: string) => {
      returning.current = userId;
      // Cleared without asking whose it was: TanStack Query calls back only the latest `mutate`,
      // so a removal overtaken by the next one never reports here.
      onRemove?.(userId, () => {
        returning.current = null;
      });
    },
    [onRemove],
  );

  const claimReturn = useCallback((userId: string): boolean => {
    if (returning.current !== userId) return false;
    returning.current = null;

    return true;
  }, []);

  return (
    <Stack gap="xs">
      {locked && <ArchivedNote id={noteId} />}
      <Table {...(locked ? { 'aria-describedby': noteId } : {})}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">{t('projects.team.column.person')}</Table.Th>
            <Table.Th scope="col">{t('projects.team.column.role')}</Table.Th>
            <Table.Th scope="col">{t('projects.team.column.allocation')}</Table.Th>
            {onRemove !== undefined && (
              <Table.Th scope="col">{t('projects.members.column.actions')}</Table.Th>
            )}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.userId}>
              <Table.Td>
                <Text size="sm">{row.label}</Text>
              </Table.Td>
              <Table.Td>
                {onChangeRole === undefined ? (
                  <Badge variant={row.projectRole === 'LEAD' ? 'filled' : 'light'}>
                    {t(PROJECT_ROLE_LABEL[row.projectRole])}
                  </Badge>
                ) : (
                  <NativeSelect
                    aria-disabled={locked || undefined}
                    aria-label={t('projects.members.roleOf', { name: row.label })}
                    data={PROJECT_ROLES.map((value) => ({
                      value,
                      label: t(PROJECT_ROLE_LABEL[value]),
                    }))}
                    ref={handOffFocus}
                    onChange={(event) => {
                      // Locked, the pick is ignored and React puts the stored role back.
                      if (locked) return;
                      onChangeRole(row.userId, event.currentTarget.value as ProjectRole);
                    }}
                    value={row.projectRole}
                  />
                )}
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {t('projects.team.allocation', {
                    percent: SharedLib.formatPercent(row.allocationPct, i18n.language),
                  })}
                </Text>
              </Table.Td>
              {onRemove !== undefined && (
                <Table.Td>
                  <ProjectMemberRemove
                    locked={locked}
                    lockedNoteId={noteId}
                    name={row.label}
                    onRemove={remove}
                    claimReturn={claimReturn}
                    userId={row.userId}
                  />
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
