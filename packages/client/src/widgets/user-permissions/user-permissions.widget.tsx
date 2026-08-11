import { Alert, Badge, Group, Stack, Switch, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { IamModel, IamService } from '@units/iam';

import { PermissionDomainGroup } from './ui/permission-domain-group.component.js';
import { PermissionOverrideDialog } from './ui/permission-override-dialog.component.js';
import classes from './user-permissions.module.css';

export interface UserPermissionsProps {
  readonly userId: string;
  /** Substring from the URL, already validated by the route's schema. */
  readonly search: string;
  readonly exceptionsOnly: boolean;
  /** Publishes a filter back to the address bar; the widget never writes the URL itself. */
  readonly onSearchChange: (value: string) => void;
  readonly onExceptionsChange: (value: boolean) => void;
}

/**
 * Everything one person may do, where each answer came from, and the three positions an
 * administrator can move any of it to.
 *
 * **The screen computes no permission.** Every row arrives with the `source` the server derived from
 * the single capability ladder shared by the request guard, the `Decision` in `domain` and this
 * answer (`permission-model.md` §«Слой 5» — «одна лестница, три потребителя»). A fourth
 * implementation on the client would agree on the day it was written and disagree the day one of
 * the others was edited — and the screen that explains an administrator's permission model would be
 * wrong exactly when it is consulted.
 *
 * What the widget owns is composition and the debounce of its own search box; the query, the two
 * mutations and the dialog's state live in `IamService.useUserPermissions`
 * (`rules/frontend-fsd.mdc` rules 5–6).
 */
export function UserPermissions({
  userId,
  search,
  exceptionsOnly,
  onSearchChange,
  onExceptionsChange,
}: UserPermissionsProps) {
  const { t } = useTranslation();
  const controller = IamService.IamHooks.useUserPermissions({ userId, search, exceptionsOnly });
  const [typed, setTyped] = useState(search);

  /**
   * One instant for the whole table, not one per row: `new Date()` inside a row would give three
   * hundred different «now»s and a new prop on every render, defeating the `memo` on the rows.
   * It is deliberately *not* a ticking clock — a relative phrase that re-renders the catalogue
   * every second would cost more than the minute of precision it buys.
   */
  const now = useMemo(() => new Date(), []);

  /**
   * Debounced in the handler rather than in an effect: typing is an event
   * (`rules/frontend-fsd.mdc` rule 11), and 300 ms keeps six keystrokes from becoming six history
   * entries.
   */
  const publish = useDebouncedCallback((value: string) => {
    onSearchChange(value.trim());
  }, 300);

  /** Stable, so the groups and the rows below can be memoised across a keystroke. */
  const choose = useCallback(
    (permission: string, choice: IamModel.PermissionChoice) => {
      controller.choose(permission, choice);
    },
    [controller],
  );

  return (
    <Stack gap="md">
      {controller.isOwner && (
        <Alert color="blue" title={t('permissions.owner.title')} variant="light">
          {t('permissions.owner.description')}
        </Alert>
      )}

      {!controller.canWrite && (
        <Alert color="gray" title={t('permissions.readOnly.title')} variant="light">
          {t('permissions.readOnly.description')}
        </Alert>
      )}

      <Group gap="xs">
        <Text size="sm">{t('permissions.rolesHeld')}</Text>
        {controller.roles.length === 0 ? (
          <Text c="var(--bc-text-muted)" size="sm">
            {t('permissions.rolesHeldNone')}
          </Text>
        ) : (
          controller.roles.map((role) => (
            <Badge key={role.roleId} variant="outline">
              {role.name}
            </Badge>
          ))
        )}
      </Group>

      <Group align="end" gap="md">
        <TextInput
          label={t('permissions.searchLabel')}
          // The schema caps it too and falls back rather than failing — but a field that quietly
          // stops accepting input is kinder than one that accepts it and drops it.
          maxLength={IamModel.PERMISSION_SEARCH_MAX_LENGTH}
          onChange={(event) => {
            setTyped(event.currentTarget.value);
            publish(event.currentTarget.value);
          }}
          placeholder={t('permissions.searchPlaceholder')}
          value={typed}
        />
        <Switch
          checked={exceptionsOnly}
          label={t('permissions.onlyExceptions')}
          onChange={(event) => {
            onExceptionsChange(event.currentTarget.checked);
          }}
        />
      </Group>

      <SharedUi.DataState
        empty={<SharedUi.EmptyState titleKey="permissions.empty" />}
        errorMessageKey="permissions.loadFailed"
        isEmpty={controller.isEmpty}
        onRetry={controller.refetch}
        skeleton={<SharedUi.TextSkeleton lines={8} />}
        status={controller.status}
      >
        <Table.ScrollContainer minWidth={720}>
          <Table captionSide="top" highlightOnHover striped>
            <Table.Caption>{t('permissions.tableCaption')}</Table.Caption>
            <Table.Thead className={classes['header']}>
              <Table.Tr>
                <Table.Th className={`${classes['rowHeader']} ${classes['corner']}`} scope="col">
                  {t('permissions.column.permission')}
                </Table.Th>
                <Table.Th scope="col">{t('permissions.column.effect')}</Table.Th>
                <Table.Th scope="col">{t('permissions.column.source')}</Table.Th>
                <Table.Th scope="col">{t('permissions.column.exception')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {controller.groups.map((group) => (
                <PermissionDomainGroup
                  canWrite={controller.canWrite}
                  domain={group.domain}
                  isOwner={controller.isOwner}
                  isSaving={controller.isSaving}
                  key={group.domain}
                  now={now}
                  onChoose={choose}
                  rows={group.rows}
                />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </SharedUi.DataState>

      <PermissionOverrideDialog
        draft={controller.draft}
        error={controller.writeError}
        isSaving={controller.isSaving}
        onClose={controller.cancel}
        onSubmit={controller.confirm}
      />
    </Stack>
  );
}
