import { Alert, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedApi } from '@shared';

import { TeamService } from '@units/team';

export interface TeamDeleteDialogProps {
  readonly opened: boolean;
  readonly teamId: string;
  readonly teamName: string;
  readonly onClose: () => void;
  /** Where to go once the team is gone — the screen it is about no longer exists. */
  readonly onDeleted: () => void;
}

/**
 * Disbanding a team, behind a confirmation that says what it costs.
 *
 * **The consequences are listed before the button, not after.** An administrator should be able to
 * decide from this dialog rather than from what they find afterwards, and «every membership is
 * removed» is the part people are surprised by: the row survives as a soft deletion so the trail can
 * still name the team, but the memberships do not — a membership is access rather than history.
 *
 * **No typed confirmation**, and that is a judgement rather than an omission
 * (`rules/design-system.mdc` §17 offers three levels). This ends a container, not a person's access
 * to everything: the accounts stay, the audit trail keeps the name, and the slug is freed for reuse.
 * A dialog that made somebody type a slug back for that would train them to type slugs back.
 *
 * **Cancel comes first in the DOM**, which is where the focus lands in a destructive dialog
 * (`rules/a11y.mdc` §6) — the safe choice should be the one a keyboard reaches without aiming.
 *
 * **The refusal is rendered here rather than left to the global toast**: the dialog is
 * `aria-modal="true"`, so while it is open nothing outside it is in the accessibility tree a screen
 * reader is confined to. The mutation declares its own `onError` so the toast stands aside, keeping
 * one action to one signal (`rules/errors-and-toasts.mdc` §2–§3, `rules/tanstack-query.mdc` §10).
 */
export function TeamDeleteDialog({
  opened,
  teamId,
  teamName,
  onClose,
  onDeleted,
}: TeamDeleteDialogProps) {
  const { t } = useTranslation();
  const disband = TeamService.TeamMutations.useDeleteTeam();

  const failureKey = disband.error === null ? undefined : SharedApi.errorMessageKey(disband.error);

  const close = (): void => {
    disband.reset();
    onClose();
  };

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it reaches
      // a screen reader as «button» — axe reports it as `button-name`.
      closeButtonProps={{ 'aria-label': t('teams.delete.cancel') }}
      onClose={close}
      opened={opened}
      title={t('teams.delete.title')}
    >
      <Stack gap="md">
        <Text>{t('teams.delete.description', { name: teamName })}</Text>

        <List size="sm">
          <List.Item>{t('teams.delete.consequence.members')}</List.Item>
          <List.Item>{t('teams.delete.consequence.access')}</List.Item>
          <List.Item>{t('teams.delete.consequence.slug')}</List.Item>
        </List>

        {failureKey !== undefined && (
          // `role="alert"`, so it is announced rather than merely drawn: the operator's attention is
          // on the button they just pressed (`rules/a11y.mdc` §13).
          <Alert color="red" role="alert" title={t('teams.delete.failed')} variant="light">
            <Text size="sm">{t(failureKey)}</Text>
          </Alert>
        )}

        <Group justify="flex-end">
          <Button onClick={close} variant="default">
            {t('teams.delete.cancel')}
          </Button>
          <Button
            color="red"
            loading={disband.isPending}
            onClick={() => {
              disband.mutate(teamId, { onSuccess: onDeleted });
            }}
          >
            {t('teams.delete.submit')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
