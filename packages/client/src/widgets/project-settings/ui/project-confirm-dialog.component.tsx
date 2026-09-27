import { Alert, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { type SharedApi } from '@shared';

import { PROJECT_ACTION_COPY, type ProjectActionKind } from '@widgets/project-settings/lib';

export interface ProjectConfirmDialogProps {
  readonly opened: boolean;
  readonly action: ProjectActionKind;
  /** The project's name, in the question — so «which project was I on» cannot be wrong. */
  readonly projectName: string;
  readonly isPending: boolean;
  /** The refusal as a sentence chosen by `code` and `reason`. Absent while nothing was refused. */
  readonly failure: SharedApi.ErrorMessage | undefined;
  /**
   * What the action would do to whom, when that is a number the server counts rather than a fixed
   * sentence — the summary of a change of visibility. Rendered above the consequences.
   */
  readonly summary?: ReactNode;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * One confirmation for the three settings actions that are not taken back from this screen: closing
 * or opening the project's visibility, archiving it, deleting it (STORY-014-01 acceptance 7,
 * `rules/design-system.mdc` §17 — the `danger` level, no typed name: none of the three destroys the
 * data, and making somebody type a key back for them would train them to type keys back).
 *
 * **Cancel comes first in the DOM**, which is where Mantine puts the focus of a destructive dialog
 * (`rules/a11y.mdc` §6): the safe choice is the one a keyboard reaches without aiming. The trap,
 * `Esc` and the return to the trigger are Mantine's own and are not overridden.
 *
 * **A refusal is rendered here, not toasted.** The dialog is `aria-modal="true"`: while it is open
 * nothing outside it is in the accessibility tree, so a toast in the corner would be no signal at all
 * to a screen reader. The mutations declare their own `onError` so the global toast stands aside
 * (`rules/errors-and-toasts.mdc` §2–§3).
 */
export function ProjectConfirmDialog({
  opened,
  action,
  projectName,
  isPending,
  failure,
  summary,
  onConfirm,
  onClose,
}: ProjectConfirmDialogProps) {
  const { t } = useTranslation();
  const copy = PROJECT_ACTION_COPY[action];
  // A spread rather than `color={… : undefined}`: under `exactOptionalPropertyTypes` an explicit
  // `undefined` is not «no colour».
  const confirmColor = copy.isDestructive ? { color: 'danger' as const } : {};

  return (
    <Modal
      // Mantine's close control is an icon button with no text; without this it is «button».
      closeButtonProps={{ 'aria-label': t('projects.confirm.cancel') }}
      onClose={onClose}
      opened={opened}
      title={t(copy.titleKey)}
    >
      <Stack gap="md">
        <Text>{t(copy.descriptionKey, { name: projectName })}</Text>
        {summary}
        <List size="sm">
          {copy.consequenceKeys.map((key) => (
            <List.Item key={key}>{t(key)}</List.Item>
          ))}
        </List>

        {failure !== undefined && (
          <Alert color="danger" role="alert" title={t(copy.failedTitleKey)} variant="light">
            <Text size="sm">{t(failure.key, failure.values ?? {})}</Text>
          </Alert>
        )}

        <Group justify="flex-end">
          <Button onClick={onClose} variant="default">
            {t('projects.confirm.cancel')}
          </Button>
          <Button loading={isPending} onClick={onConfirm} {...confirmColor}>
            {t(copy.confirmKey)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
