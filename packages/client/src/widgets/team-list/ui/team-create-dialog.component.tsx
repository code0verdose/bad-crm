import { Alert, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedApi } from '@shared';

import { TeamLib, TeamService, TeamUi } from '@units/team';

export interface TeamCreateDialogProps {
  readonly opened: boolean;
  readonly onClose: () => void;
}

/** An empty form. Named here so «reset on close» and «open for the first time» are one value. */
const BLANK = { name: '', slug: '', description: '' } as const;

/**
 * Creating a team, in a dialog.
 *
 * A modal rather than a route, by the rule that decides between them (`rules/design-system.mdc` §16):
 * three fields, under thirty seconds of attention, and nothing anybody would want to send as a link.
 *
 * **The refusal is rendered here rather than left to the global toast.** The dialog is
 * `aria-modal="true"`, so while it is open nothing outside it is in the accessibility tree a screen
 * reader is confined to: a toast in the corner would be, for that reader, no signal at all. The
 * mutation therefore declares its own `onError` and the toast stands aside, which keeps one action
 * to one signal (`rules/errors-and-toasts.mdc` §2–§3, `rules/tanstack-query.mdc` §10).
 *
 * `409 team_already_exists` is the refusal this really produces, and it is shown as a whole sentence
 * rather than pinned to the slug field: the constraint is on the pair the server checks, and a
 * message under one input would be a claim about which half was wrong.
 *
 * The form is remounted on every open (`key`), which is what makes «closed and reopened» start from
 * nothing without an effect to clear it — the reset `rules/frontend-fsd.mdc` rule 11 asks for.
 */
export function TeamCreateDialog({ opened, onClose }: TeamCreateDialogProps) {
  const { t } = useTranslation();
  const create = TeamService.TeamMutations.useCreateTeam();

  const failureKey = create.error === null ? undefined : SharedApi.errorMessageKey(create.error);

  const close = (): void => {
    create.reset();
    onClose();
  };

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it reaches
      // a screen reader as «button» — axe reports it as `button-name`.
      closeButtonProps={{ 'aria-label': t('teams.create.close') }}
      onClose={close}
      opened={opened}
      title={t('teams.create.title')}
    >
      <Stack gap="md">
        <Text size="sm">{t('teams.create.description')}</Text>

        {failureKey !== undefined && (
          // `role="alert"`, so it is announced rather than merely drawn: the operator's attention is
          // on the button they just pressed (`rules/a11y.mdc` §13). The text comes from the `code`,
          // never from `detail` — the technical half went to the log.
          <Alert color="red" role="alert" title={t('teams.create.failed')} variant="light">
            <Text size="sm">{t(failureKey)}</Text>
          </Alert>
        )}

        <TeamUi.TeamForm
          initialValues={{ ...BLANK }}
          isPending={create.isPending}
          key={String(opened)}
          onSubmit={(values) => {
            create.mutate(TeamLib.toTeamDraft(values), { onSuccess: close });
          }}
          submitLabelKey="teams.create.submit"
        />
      </Stack>
    </Modal>
  );
}
