import { useTranslation } from 'react-i18next';

import { AuthService } from '@units/auth';
import { EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';
import { ProjectLib, ProjectService, ProjectUi } from '@units/project';
import { createLeadChoices } from '@widgets/project-create/lib';

export interface ProjectCreateProps {
  /** Where to go once the project exists — its card, which the mutation has already cached. */
  readonly onCreated: (projectId: string) => void;
}

/**
 * The create form, with the two things it needs from other units: who the reader is (the default
 * lead) and who else could lead (the directory, behind `user:read`).
 *
 * A page rather than a modal (`rules/design-system.mdc` §16): eight fields are more than thirty
 * seconds of attention, and a half-filled form in a dialog is lost to one stray `Esc`.
 *
 * Without `user:read` the reader may not be told who else is in the organization, so the only lead
 * on offer is themselves — the one choice the server always accepts on a create.
 */
export function ProjectCreate({ onCreated }: ProjectCreateProps) {
  const { t } = useTranslation();
  const { can } = IamService.IamHooks.useCan();
  const session = AuthService.useBootstrapSession();
  const creation = ProjectService.ProjectHooks.useProjectCreation();
  const directory = EmployeeService.EmployeeHooks.useDirectory(can('user:read'));

  const readerId = session.status === 'authenticated' ? session.userId : undefined;

  return (
    <ProjectUi.ProjectForm
      // Keyed by the reader: the default lead is the session's user, and a form mounted before the
      // session answered would keep an empty lead for ever (an uncontrolled form reads its initial
      // values once). In the application the session is known long before this page renders.
      key={readerId ?? 'no-session'}
      colorOptions={ProjectLib.projectColorOptions()}
      failure={creation.failure}
      initialValues={ProjectLib.newProjectValues(readerId)}
      isPending={creation.isPending}
      leadOptions={createLeadChoices(directory.people, readerId, t('projects.field.leadYou'))}
      mode="create"
      onSubmit={(values) => {
        creation.create(values, onCreated);
      }}
      submitLabelKey="projects.create.submit"
    />
  );
}
