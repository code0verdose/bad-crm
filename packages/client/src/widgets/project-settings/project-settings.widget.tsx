import { Button, Group, Text } from '@mantine/core';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedLib, SharedUi } from '@shared';

import { leadChoices, type ProjectActionKind } from '@widgets/project-settings/lib';
import { EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';
import { ProjectLib, ProjectService, ProjectUi } from '@units/project';

import { ProjectConfirmDialog } from './ui/project-confirm-dialog.component.js';

export interface ProjectSettingsProps {
  readonly projectId: string;
  /** Where to go once the project is deleted — this screen is about something that stopped existing. */
  readonly onDeleted: () => void;
}

/**
 * `/projects/$projectId/settings`: editing the project, its visibility, and the danger zone
 * (STORY-014-01, client half).
 *
 * **Every section is drawn from the card's `permissions` block** (STORY-014-05, acceptance 5): the
 * edit form from `canEdit`, the visibility button from `canChangeVisibility`, the archive button
 * from `canArchive`, the delete button from `canDelete`, and whether the lead may be changed from
 * `canManageMembers`. None of the project's controls reads the reader's capability set (only the
 * directory of people does, through `user:read`): a key the reader holds says nothing about the
 * `MANAGER` level the command also needs on the chain, and the flag is the server's decision of both
 * (`docs/security/permission-model.md` §7(е)).
 *
 * **An archived project keeps its controls on screen and within reach** (acceptance 7): not a hard
 * `disabled`, which dropped them from the tab order with the reason in a banner far above, but
 * `aria-disabled` with a note beside each section's controls saying why (`rules/a11y.mdc` §23), and
 * no handler behind them — the code refuses, not the attribute. Deleting stays available: the banner promises that nothing *in* the project
 * changes, and deletion is about the project as a whole, the one thing an archive is often for.
 *
 * One confirmation dialog for the three actions that are not taken back from here; which one is open
 * is this screen's state, because it dies with the screen (`rules/frontend-fsd.mdc` rule 16).
 */
export function ProjectSettings({ projectId, onDeleted }: ProjectSettingsProps) {
  const { t } = useTranslation();
  const { can } = IamService.IamHooks.useCan();
  const view = ProjectService.ProjectHooks.useProject(projectId);
  const controls = ProjectService.ProjectHooks.useProjectControls(projectId);
  const editing = ProjectService.ProjectHooks.useProjectEditing(projectId);
  const visibility = ProjectService.ProjectHooks.useProjectVisibilityChange(projectId);
  const archival = ProjectService.ProjectHooks.useProjectArchival(projectId);
  const deletion = ProjectService.ProjectHooks.useProjectDeletion(projectId);
  const directory = EmployeeService.EmployeeHooks.useDirectory(can('user:read'));
  const [action, setAction] = useState<ProjectActionKind | null>(null);
  const visibilityNoteId = useId();
  const dangerNoteId = useId();

  const { project } = view;
  const visibilityAction: ProjectActionKind = visibility.target === 'PRIVATE' ? 'close' : 'open';
  const running = action === 'archive' ? archival : action === 'delete' ? deletion : visibility;

  const close = (): void => {
    running.dismiss();
    setAction(null);
  };

  const confirm = (): void => {
    if (action === 'archive') archival.run(close);
    else if (action === 'delete') deletion.run(onDeleted);
    else visibility.confirm(close);
  };

  if (!controls.hasSettings) {
    return <Text c="var(--bc-text-muted)">{t('projects.settings.nothing')}</Text>;
  }

  return (
    <>
      {controls.canEdit && (
        <SharedUi.Section
          descriptionKey="projects.settings.edit.description"
          titleKey="projects.settings.edit.title"
        >
          <ProjectUi.ProjectForm
            // Keyed by what the server holds: a save that changes the project starts the form again
            // from the new values, instead of an effect copying them into the old one.
            key={JSON.stringify(editing.initialValues)}
            colorOptions={ProjectLib.projectColorOptions(project.color)}
            failure={editing.failure}
            initialValues={editing.initialValues}
            isPending={editing.isPending}
            leadOptions={leadChoices(directory.people, project.leadId, controls.canManageMembers)}
            locked={controls.isArchived}
            mode="edit"
            onSubmit={editing.save}
            submitLabelKey="projects.settings.edit.submit"
          />
        </SharedUi.Section>
      )}

      {controls.canChangeVisibility && (
        <SharedUi.Section
          descriptionKey="projects.settings.visibility.description"
          titleKey="projects.settings.visibility.title"
        >
          <Text>
            {t('projects.settings.visibility.current', { value: t(view.visibilityLabelKey) })}
          </Text>
          {controls.isArchived && <ProjectUi.ArchivedNote id={visibilityNoteId} />}
          <Group>
            <Button
              {...(controls.isArchived ? SharedLib.lockedControlProps(visibilityNoteId) : {})}
              onClick={
                controls.isArchived
                  ? undefined
                  : () => {
                      setAction(visibilityAction);
                    }
              }
              variant="light"
            >
              {t('projects.settings.visibility.change', { value: t(visibility.targetLabelKey) })}
            </Button>
          </Group>
        </SharedUi.Section>
      )}

      {(controls.canArchive || controls.canDelete) && (
        <SharedUi.Section
          descriptionKey="projects.settings.danger.description"
          titleKey="projects.settings.danger.title"
        >
          {controls.isArchived && controls.canArchive && (
            <ProjectUi.ArchivedNote id={dangerNoteId} />
          )}
          <Group>
            {controls.canArchive && (
              <Button
                {...(controls.isArchived ? SharedLib.lockedControlProps(dangerNoteId) : {})}
                onClick={
                  controls.isArchived
                    ? undefined
                    : () => {
                        setAction('archive');
                      }
                }
                variant="light"
              >
                {t('projects.archive.action')}
              </Button>
            )}
            {controls.canDelete && (
              <Button
                color="danger"
                onClick={() => {
                  setAction('delete');
                }}
                variant="light"
              >
                {t('projects.delete.action')}
              </Button>
            )}
          </Group>
        </SharedUi.Section>
      )}

      <ProjectConfirmDialog
        action={action ?? visibilityAction}
        failure={running.failure}
        isPending={running.isPending}
        onClose={close}
        onConfirm={confirm}
        opened={action !== null}
        projectName={project.name}
      />
    </>
  );
}
