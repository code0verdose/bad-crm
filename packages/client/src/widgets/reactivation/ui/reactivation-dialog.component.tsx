import { Alert, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';

import { ReactivationReport } from './reactivation-report.component.js';
import { ReactivationRoles } from './reactivation-roles.component.js';

export interface ReactivationDialogProps {
  readonly opened: boolean;
  readonly userId: string;
  /** Whose account this is about. Shown so the operator can recognise the person, never typed back. */
  readonly email: string;
  /**
   * Closed, and where the focus should go now: back to the trigger while it is still there, to the
   * page heading once a successful run has taken the section away. The widget above owns the move;
   * this dialog owns the answer, because it is the only thing that knows what happened inside it.
   */
  readonly onClose: (focusReturn: 'trigger' | 'heading') => void;
}

/**
 * Bringing an account back, behind a confirmation that says what does and does not come with it.
 *
 * **No typed confirmation, and that is a judgement rather than an omission.**
 * `rules/design-system.mdc` §17 offers three levels and reserves the strictest for destroying a
 * person or a container; both red buttons on this card take something away irreversibly, and this
 * one gives access back — a mis-click here is undone by the offboarding control ten centimetres
 * above it. What the confirmation is for is not the click but the **list**: an administrator who has
 * not thought about the roles below should not be able to arrive at «done» without having read them.
 *
 * **What comes back is stated before what does not, and both before the button.** People are
 * surprised by the second half later — «he is back but he cannot see the project» — and the dialog
 * is where that belongs, not the report: a decision made from the report is a decision made after
 * the fact.
 *
 * **A refusal is rendered here rather than left to the global toast.** The dialog is
 * `aria-modal="true"`, so while it is open nothing outside it is in the accessibility tree a screen
 * reader is confined to; the mutation therefore declares its own `onError` and the toast stands
 * aside, which keeps this action to one signal (`rules/errors-and-toasts.mdc` §2–§3,
 * `rules/tanstack-query.mdc` §10). Both refusals this endpoint really produces are read the same
 * way: 403 `user_forbidden` when the caller does not hold everything the account holds, 404 for
 * somebody of another organization.
 *
 * **After a successful run the dialog stays open and shows the report**, for the reason the two
 * dialogs beside it do — and here it also decides when the card is refreshed: the record is read
 * again on close rather than on success, because refreshing it flips the state to active and takes
 * this section, this dialog and this report off the screen at once (see `use-reactivation.hook.ts`).
 *
 * `returnFocus={false}`: where the focus goes when this closes depends on *why* it closed, and after
 * a successful run the trigger no longer exists. That is one decision, made by the widget above,
 * which is the thing that holds both destinations.
 */
export function ReactivationDialog({ opened, userId, email, onClose }: ReactivationDialogProps) {
  const { t } = useTranslation();
  const reactivation = EmployeeService.EmployeeHooks.useReactivation(userId);
  const { can } = IamService.IamHooks.useCan();

  /**
   * Whether the roles can be named at all. A hint and never a gate — what it decides is whether to
   * spend a request that would always be refused (`rules/permissions.mdc` §11), not who may do
   * anything. Read here rather than in the markup below, where a permission key is a bare string
   * literal in JSX and the i18n rule cannot tell it from a sentence somebody forgot to translate.
   */
  const canNameRoles = can('permission:override_read');

  const dismiss = (): void => {
    // Read before the state is cleared: a run that succeeded has just removed the control this
    // dialog was opened from, so there is nowhere to send the focus back to.
    const focusReturn = reactivation.result === undefined ? 'trigger' : 'heading';

    reactivation.dismiss();
    onClose(focusReturn);
  };

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it reaches
      // a screen reader as «button» — axe reports it as `button-name`.
      closeButtonProps={{ 'aria-label': t('members.reactivate.close') }}
      onClose={dismiss}
      opened={opened}
      returnFocus={false}
      title={t('members.reactivate.dialog.title')}
    >
      {reactivation.result === undefined ? (
        <Stack gap="md">
          <Text>{t('members.reactivate.dialog.description', { email })}</Text>

          <Stack gap="xs">
            <Text fw={600} size="sm">
              {t('members.reactivate.restored.title')}
            </Text>
            <List size="sm">
              <List.Item>{t('members.reactivate.restored.signIn')}</List.Item>
              <List.Item>
                {/*
                  Mounted only for a caller who may read somebody else's rights. Without the
                  permission the answer would be a 403 the interface can do nothing with, so the
                  dialog says the list cannot be shown rather than spending the request to find out
                  (`rules/permissions.mdc` §11 — the check is a hint, and this is what a hint is for).
                */}
                {canNameRoles ? (
                  <ReactivationRoles userId={userId} />
                ) : (
                  <Text size="sm">{t('members.reactivate.roles.hidden')}</Text>
                )}
              </List.Item>
            </List>
          </Stack>

          <Alert color="warning" title={t('members.reactivate.limits.title')} variant="light">
            <Text size="sm">{t('members.reactivate.limits.description')}</Text>
            <List size="sm">
              <List.Item>{t('members.reactivate.limits.teams')}</List.Item>
              <List.Item>{t('members.reactivate.limits.projects')}</List.Item>
              <List.Item>{t('members.reactivate.limits.vaults')}</List.Item>
            </List>
          </Alert>

          {reactivation.failureKey !== undefined && (
            // The text comes from the `code`, never from `detail` — the technical half went to the
            // log. `Alert` announces itself (`role="alert"`), which is what an operator whose
            // attention is on the button they just pressed needs (`rules/a11y.mdc` §13).
            <Alert color="danger" title={t('members.reactivate.failed.title')} variant="light">
              <Text size="sm">{t(reactivation.failureKey)}</Text>
            </Alert>
          )}

          {/* Cancel first in the DOM: the choice that changes nothing is the one a keyboard reaches
              without aiming (`rules/a11y.mdc` §6). */}
          <Group justify="flex-end">
            <Button onClick={dismiss} variant="default">
              {t('members.reactivate.cancel')}
            </Button>
            <Button loading={reactivation.isPending} onClick={reactivation.reactivate}>
              {t('members.reactivate.submit')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          <ReactivationReport result={reactivation.result} />
          <Group justify="flex-end">
            <Button onClick={dismiss} variant="default">
              {t('members.reactivate.close')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
