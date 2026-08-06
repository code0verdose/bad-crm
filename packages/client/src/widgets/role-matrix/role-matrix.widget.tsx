import { memo, useMemo } from 'react';
import { useDisclosure } from '@mantine/hooks';
import { useBlocker } from '@tanstack/react-router';
import { Stack, Table } from '@mantine/core';
import { type SharedPermissions } from '@bad-crm/shared';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { IamService, type IamApi } from '@units/iam';

import { RoleMatrixDraftBar } from './ui/role-matrix-draft-bar.component.js';
import { RoleMatrixGroup } from './ui/role-matrix-group.component.js';
import { RoleMatrixPreviewModal } from './ui/role-matrix-preview-modal.component.js';
import { groupPermissions } from './lib/group-permissions.util.js';
import classes from './role-matrix.module.css';

/** One frozen array, so «no data yet» is the same reference every time. */
const EMPTY_ROLES: readonly IamApi.RoleListEntry[] = [];

export interface RoleMatrixProps {
  readonly search: string;
  readonly collapsed: readonly SharedPermissions.PermissionDomain[];
  readonly onlyDifferences: boolean;
  readonly onCollapse: (domain: SharedPermissions.PermissionDomain) => void;
}

/**
 * Every role against every permission, with the unsaved draft and the summary that precedes a save.
 *
 * The widget is the composition point: it asks the unit for the roles, holds the draft through the
 * unit's hook, and hands both to presentational components. What it does not do is decide anything
 * about permissions — which cells are editable, which changes are refused and how many people they
 * reach all come from the same place the server decides, which is the point of the preview.
 */
function RoleMatrixView({ search, collapsed, onlyDifferences, onCollapse }: RoleMatrixProps) {
  const { t } = useTranslation();
  const query = IamService.IamQueries.useRolesMatrixQuery();
  /**
   * Memoised for a reason the linter names precisely: `query.data ?? []` builds a new array on every
   * render while the query is pending, and that array is a dependency of the grouping below — the
   * whole catalogue would be walked again on every keystroke to produce the same answer.
   */
  const roles = useMemo(() => query.data ?? EMPTY_ROLES, [query.data]);
  const draft = IamService.IamHooks.useRoleMatrixDraft(roles);
  const preview = IamService.IamQueries.useRoleChangesPreview();
  const apply = IamService.IamMutations.useApplyRoleChanges();
  const [opened, modal] = useDisclosure(false);

  /**
   * Leaving with unsaved cells asks first.
   *
   * The draft lives in memory and nowhere else — that is the deliberate half of the design, because
   * a screenful of toggles in the URL would be shared as if it were the truth. The cost of that
   * choice is that a navigation throws the work away, so the navigation is the place to say so.
   */
  useBlocker({
    shouldBlockFn: () => draft.changeCount > 0 && !globalThis.confirm(t('roles.draft.leave')),
    // A value, not a callback: this component re-renders whenever the count changes, so the two are
    // equivalent — and a callback would be a function no test in this suite can reach, because the
    // `beforeunload` listener is attached by the browser history and the suite runs on a memory one.
    enableBeforeUnload: draft.changeCount > 0,
  });

  /**
   * Memoised because it walks the whole catalogue — 331 keys × a column per role — and the page
   * above re-renders on every keystroke of the search box.
   */
  const groups = useMemo(
    () => groupPermissions({ roles, search, onlyDifferences, grants: draft.grants }),
    [roles, search, onlyDifferences, draft.grants],
  );

  const outcomes = preview.data ?? [];

  const review = (): void => {
    preview.mutate(
      { changes: draft.changes },
      {
        onSuccess: () => {
          modal.open();
        },
      },
    );
  };

  const confirm = (): void => {
    const dangerous = outcomes.some((outcome) => outcome.dangerous.length > 0);

    apply.mutate(
      { changes: { changes: draft.changes }, ...(dangerous ? { confirmDangerous: true } : {}) },
      {
        onSuccess: () => {
          modal.close();
          draft.reset();
        },
      },
    );
  };

  return (
    <Stack gap="md">
      <SharedUi.DataState
        status={query.status}
        errorMessageKey="roles.loadFailed"
        onRetry={() => void query.refetch()}
        skeleton={<SharedUi.TextSkeleton lines={8} />}
        isEmpty={roles.length === 0}
        empty={<SharedUi.EmptyState titleKey="roles.empty" />}
      >
        <Table.ScrollContainer minWidth={640}>
          <Table striped highlightOnHover captionSide="top">
            <Table.Caption>{t('roles.tableCaption')}</Table.Caption>
            <Table.Thead className={classes['header']}>
              <Table.Tr>
                <Table.Th className={`${classes['rowHeader']} ${classes['corner']}`} scope="col">
                  {t('roles.permissionColumn')}
                </Table.Th>
                {roles.map((role: IamApi.RoleListEntry) => (
                  <Table.Th key={role.id} scope="col">
                    {role.name}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {groups.map((group) => (
                <RoleMatrixGroup
                  key={group.domain}
                  domain={group.domain}
                  permissions={group.permissions}
                  roles={roles}
                  collapsed={collapsed.includes(group.domain)}
                  grants={draft.grants}
                  onToggle={draft.toggle}
                  onCollapse={onCollapse}
                />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </SharedUi.DataState>

      <RoleMatrixDraftBar
        changeCount={draft.changeCount}
        isSaving={preview.isPending || apply.isPending}
        onReview={review}
        onDiscard={draft.reset}
      />

      <RoleMatrixPreviewModal
        opened={opened}
        outcomes={outcomes}
        isSaving={apply.isPending}
        onConfirm={confirm}
        onClose={modal.close}
      />
    </Stack>
  );
}

/**
 * Memoised, and it is not premature: the page above holds the search box, so it re-renders on every
 * keystroke, and this subtree is the whole catalogue against every role — three hundred rows times a
 * column each. Without this the debounce would still spare the network and spend the frame.
 */
export const RoleMatrix = memo(RoleMatrixView);
