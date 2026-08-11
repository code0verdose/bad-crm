import { Table, Text } from '@mantine/core';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { IamModel, type IamTypes } from '@units/iam';
import classes from '@widgets/user-permissions/user-permissions.module.css';

import { PermissionChoiceControl } from './permission-choice-control.component.js';
import { PermissionExceptionNote } from './permission-exception-note.component.js';
import { PermissionSourceBadge } from './permission-source-badge.component.js';

export interface PermissionRowProps {
  readonly row: IamTypes.PermissionRow;
  /** Whether to draw a control at all — `permission:override`, the write half. */
  readonly canWrite: boolean;
  /** The owner's rights cannot be taken away, so there is nothing to offer on their card. */
  readonly isOwner: boolean;
  readonly isSaving: boolean;
  readonly now: Date;
  readonly onChoose: (permission: string, choice: IamModel.PermissionChoice) => void;
}

/**
 * One key of the catalogue as one line: what it is, what may be done about it, and who arranged it.
 *
 * **Where the control is absent, a word stands in its place** — never a disabled control with no
 * explanation. Two cases, and neither is a permission the interface is enforcing:
 *
 *   * **the owner.** A DENY on the owner is refused by the use-case *and* by a database trigger
 *     (`permission-model.md` §«Слой 3»), so a control here would offer an act that cannot happen.
 *     The row says `OWNER` through its badge and the tab says why once, above the table — an
 *     explanation repeated three hundred times is noise, and a greyed-out control repeated three
 *     hundred times with no explanation at all is worse;
 *   * **a reader without `permission:override`.** The endpoint refuses on its own authority; what
 *     the check prevents is offering an action that always answers 403 (`ux-architecture.md`,
 *     принцип 6). The state stays fully readable — that is what they came for.
 *
 * The position of the control is read off `override`, not off `source`: the exception **is** the
 * position, and «no exception» is the third. Deriving it from the source would be this client
 * walking the capability ladder, which is the one thing this screen must not do.
 */
function PermissionTableRow({
  row,
  canWrite,
  isOwner,
  isSaving,
  now,
  onChoose,
}: PermissionRowProps) {
  const { t } = useTranslation();

  return (
    <Table.Tr>
      <Table.Th className={classes['rowHeader']} scope="row">
        <Text component="span" size="sm">
          {row.key}
        </Text>
        {row.dangerous && (
          <Text c="red" component="span" size="xs">
            {` ${t('permissions.dangerous')}`}
          </Text>
        )}
      </Table.Th>

      <Table.Td>
        {canWrite && !isOwner ? (
          <PermissionChoiceControl
            disabled={isSaving}
            onChoose={(choice) => {
              onChoose(row.key, choice);
            }}
            permission={row.key}
            value={row.override === null ? 'INHERITED' : row.override.effect}
          />
        ) : (
          <Text size="sm">
            {t(
              IamModel.PERMISSION_CHOICE_LABEL_KEY[
                row.override === null ? 'INHERITED' : row.override.effect
              ],
            )}
          </Text>
        )}
      </Table.Td>

      <Table.Td>
        <PermissionSourceBadge inheritedFrom={row.inheritedFrom} source={row.source} />
      </Table.Td>

      <Table.Td>
        {row.override === null ? null : (
          <PermissionExceptionNote now={now} override={row.override} />
        )}
      </Table.Td>
    </Table.Tr>
  );
}

/**
 * Memoised, and the props are what make it work: `onChoose` and `now` come from the widget as stable
 * values, so typing in the search box re-renders the rows that the filter changed and no others.
 */
export const PermissionRow = memo(PermissionTableRow);
