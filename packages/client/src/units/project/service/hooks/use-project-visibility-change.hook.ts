import { useCallback } from 'react';

import { type ErrorMessage } from '@shared/api';
import { projectRefusalMessage, visibilityImpactMessage } from '@units/project/lib';
import { PROJECT_VISIBILITY_LABEL, type ProjectVisibility } from '@units/project/model';
import { useChangeProjectVisibility } from '@units/project/service/mutations/change-project-visibility.mutation.js';
import { useProjectDetailQuery } from '@units/project/service/queries/project-detail.query.js';
import { useProjectVisibilityImpactQuery } from '@units/project/service/queries/project-visibility-impact.query.js';

/**
 * The summary the dialog shows before the change is confirmed — the server's count, as a sentence.
 *
 * Three states and no fourth: while the count is on its way the dialog holds its place, a failed
 * read says so inside the dialog with a retry (never a toast: the dialog is `aria-modal`, and a
 * summary that failed to load is not a failed action), and a loaded one is one sentence.
 */
export interface ProjectVisibilityImpactView {
  readonly status: 'pending' | 'error' | 'success';
  /** The sentence, once the count is here. */
  readonly message: ErrorMessage | undefined;
  /** Why the count could not be read. The change itself is still possible — the server decides it. */
  readonly failure: ErrorMessage | undefined;
  readonly retry: () => void;
}

export interface ProjectVisibilityChange {
  /** The visibility the project would move to — the only other value there is. */
  readonly target: ProjectVisibility;
  readonly targetLabelKey: string;
  /** How many colleagues the change moves, read while `previewing`. */
  readonly impact: ProjectVisibilityImpactView;
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
 * sent — the dialog names the consequences and **how many colleagues** the change moves
 * (STORY-014-01, acceptance 7; the count is the server's `GET …/visibility-impact`, read only while
 * `previewing`) — so the one request it makes carries the confirmation it has actually collected.
 * Should the server still answer 428 — a stale bundle, a header lost on the way — it is a refusal
 * like any other, rendered in the dialog in its own words.
 */
export const useProjectVisibilityChange = (
  projectId: string,
  previewing: boolean,
): ProjectVisibilityChange => {
  const { data: project } = useProjectDetailQuery(projectId);
  const { error, isPending, mutate, reset } = useChangeProjectVisibility();

  const target: ProjectVisibility = project.visibility === 'PRIVATE' ? 'PUBLIC_ORG' : 'PRIVATE';
  const preview = useProjectVisibilityImpactQuery(projectId, target, previewing);

  const confirm = useCallback(
    (onChanged: () => void) => {
      mutate({ projectId, visibility: target }, { onSuccess: onChanged });
    },
    [mutate, projectId, target],
  );

  const retry = useCallback(() => {
    void preview.refetch();
  }, [preview]);

  return {
    target,
    targetLabelKey: PROJECT_VISIBILITY_LABEL[target],
    impact: {
      status: preview.status,
      message:
        preview.data === undefined ? undefined : visibilityImpactMessage(target, preview.data),
      failure: preview.error === null ? undefined : projectRefusalMessage(preview.error),
      retry,
    },
    failure: error === null ? undefined : projectRefusalMessage(error),
    isPending,
    confirm,
    dismiss: reset,
  };
};
