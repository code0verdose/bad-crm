import { useCallback } from 'react';

import { type ErrorMessage } from '@shared/api';
import { projectRefusalMessage } from '@units/project/lib';
import { PROJECT_VISIBILITY_LABEL, type ProjectVisibility } from '@units/project/model';
import { useChangeProjectVisibility } from '@units/project/service/mutations/change-project-visibility.mutation.js';
import { useProjectDetailQuery } from '@units/project/service/queries/project-detail.query.js';

export interface ProjectVisibilityChange {
  /** The visibility the project would move to — the only other value there is. */
  readonly target: ProjectVisibility;
  readonly targetLabelKey: string;
  readonly failure: ErrorMessage | undefined;
  readonly isPending: boolean;
  /** Sends the change with `X-Confirm-Dangerous: 1`. `onChanged` fires only on success. */
  readonly confirm: (onChanged: () => void) => void;
  /** The dialog is done with: forgets the refusal, so the next open starts clean. */
  readonly dismiss: () => void;
}

/**
 * Opening a project to the organization or closing it, as the confirmation dialog renders it.
 *
 * **The confirmation is the dialog, and the header says so.** The contract's two-step shape — a
 * bare request answered `428 confirmation_required`, then a repeat with `X-Confirm-Dangerous: 1` —
 * exists for a client that did not show what the change does. This one shows it before anything is
 * sent (the dialog lists the consequences), so the one request it makes carries the confirmation it
 * has actually collected. Should the server still answer 428 — a stale bundle, a header lost on the
 * way — it is a refusal like any other, rendered in the dialog in its own words.
 */
export const useProjectVisibilityChange = (projectId: string): ProjectVisibilityChange => {
  const { data: project } = useProjectDetailQuery(projectId);
  const { error, isPending, mutate, reset } = useChangeProjectVisibility();

  const target: ProjectVisibility = project.visibility === 'PRIVATE' ? 'PUBLIC_ORG' : 'PRIVATE';

  const confirm = useCallback(
    (onChanged: () => void) => {
      mutate({ projectId, visibility: target }, { onSuccess: onChanged });
    },
    [mutate, projectId, target],
  );

  return {
    target,
    targetLabelKey: PROJECT_VISIBILITY_LABEL[target],
    failure: error === null ? undefined : projectRefusalMessage(error),
    isPending,
    confirm,
    dismiss: reset,
  };
};
