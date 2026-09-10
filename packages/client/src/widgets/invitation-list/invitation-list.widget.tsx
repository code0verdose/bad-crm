import { Button, Stack } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import {
  invitationRows,
  type InvitationActionKind,
  type InvitationRow,
} from '@widgets/invitation-list/lib';
import { EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';

import { InvitationConfirmDialog } from './ui/invitation-confirm-dialog.component.js';
import { InvitationTable } from './ui/invitation-table.component.js';
import classes from './invitation-list.module.css';

/** Rows of the skeleton, so the page does not jump when the answer arrives. */
const SKELETON_ROWS = 6;

/** Which row a confirmation is about, and what it would do to it. */
interface InvitationAsk {
  readonly action: InvitationActionKind;
  readonly id: string;
  readonly email: string;
}

/**
 * Every invitation nobody has accepted yet, and the two things one can do about each.
 *
 * The composition point (`rules/frontend-fsd.mdc` rule 7). It asks the unit for the list and the two
 * operations through one hook and renders the answer. It sorts nothing and filters nothing: the
 * endpoint takes no parameters, the order is the server's, and an expired invitation is on the list
 * on purpose — it is exactly the row somebody came here to re-issue or close.
 *
 * **The names are three permissions away from the list itself.** `Invitation` carries `roleId`,
 * `teamIds` and `invitedById` and no names, so the screen asks for them separately and **only when
 * it may**: roles and people through the unit hook that owns each read, teams by not mounting the
 * cell at all (see `InvitationTeams`). A reader holding nothing but `invitation:read` makes exactly
 * one request and sees a dash where a name would be — never a raw identifier, which is noise rather
 * than information (STORY-012-08, D1).
 *
 * **Both action controls are hints.** The endpoints refuse on their own authority; hiding a button
 * that would answer 403 is a kindness, not the check.
 */
export function InvitationList() {
  const { t } = useTranslation();
  const { can } = IamService.IamHooks.useCan();
  const list = IamService.IamHooks.useInvitationList();
  const roles = IamService.IamHooks.useAssignableRoles();
  const directory = EmployeeService.EmployeeHooks.useDirectory(can('employee:read'));
  const [ask, setAsk] = useState<InvitationAsk | null>(null);
  const mayCreate = can('invitation:create');
  const mayResend = can('invitation:resend');
  const mayRevoke = can('invitation:revoke');
  const mayReadTeams = can('team:read');

  // The join stays here, and not in either unit: neither the invitations nor the directory owns the
  // other, and a screen combining two units' answers is what a widget is for.
  const rows = invitationRows(list.items, roles.entries, directory.people);
  // Before the first question, `revoke` stands in: the dialog renders nothing while it is shut, and
  // the handlers below then need no null check of their own.
  const action = ask === null ? list.revoke : list[ask.action];
  /**
   * Shuts the question and forgets whatever the mutation answered.
   *
   * The minted link goes with it: it lives in the mutation result, `gcTime: 0`, and nowhere else
   * (criterion 8).
   */
  const close = () => {
    action.reset();
    setAsk(null);
  };

  return (
    <Stack gap="md">
      <SharedUi.DataState
        empty={
          <SharedUi.EmptyState
            action={
              mayCreate ? (
                <Button component={Link} to="/admin/members/invite">
                  {t('members.invite.title')}
                </Button>
              ) : undefined
            }
            descriptionKey="members.invitations.empty.description"
            titleKey="members.invitations.empty.title"
          />
        }
        errorMessageKey="members.invitations.failed"
        isEmpty={rows.length === 0}
        onRetry={list.refetch}
        skeleton={<SharedUi.TextSkeleton lines={SKELETON_ROWS} />}
        status={list.status}
      >
        <div className={classes['scroller']}>
          {/*
            Two spreads rather than one object holding `undefined`: under
            `exactOptionalPropertyTypes` an explicit `undefined` is not the same as «no property»,
            and the table draws the actions column from the presence of a handler.
          */}
          <InvitationTable
            mayReadTeams={mayReadTeams}
            rows={rows}
            {...(mayResend
              ? {
                  onResend: (row: InvitationRow) => {
                    list.resend.reset();
                    setAsk({ action: 'resend', id: row.id, email: row.email });
                  },
                }
              : {})}
            {...(mayRevoke
              ? {
                  onRevoke: (row: InvitationRow) => {
                    list.revoke.reset();
                    setAsk({ action: 'revoke', id: row.id, email: row.email });
                  },
                }
              : {})}
          />
        </div>
      </SharedUi.DataState>

      {/*
        Always mounted, opened by the state — **not** rendered only while a question is on screen.
        Unmounting a Mantine `Modal` skips the close it performs, and the focus never comes back to
        the control it was opened from (`rules/a11y.mdc` §6). Measured, not deduced: rendered
        conditionally, `Esc` left the focus on `<body>` and the suite said so.
      */}
      <InvitationConfirmDialog
        action={ask?.action ?? 'revoke'}
        email={ask?.email ?? ''}
        isPending={action.isPending}
        onClose={close}
        onConfirm={() => {
          if (ask === null) return;

          // The re-issue keeps the dialog open — the link it produced is the only copy there will
          // ever be. The revoke closes it, because the row it was about is gone.
          action.run(ask.id, ask.action === 'revoke' ? close : undefined);
        }}
        opened={ask !== null}
        {...(action.failure === undefined ? {} : { failure: action.failure })}
        {...(ask?.action === 'resend' && list.minted !== undefined ? { minted: list.minted } : {})}
      />
    </Stack>
  );
}
