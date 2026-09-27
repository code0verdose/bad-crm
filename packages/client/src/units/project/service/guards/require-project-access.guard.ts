import { type QueryClient } from '@tanstack/react-query';
import { notFound } from '@tanstack/react-router';

import { projectDetailQueryOptions } from '@units/project/service/queries/project-detail.query.js';
import {
  recentProjects,
  type RecentProjectsStore,
} from '@units/project/service/stores/recent-projects.store.js';
import { isApiError } from '@shared/api';

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/** The slice of `beforeLoad` arguments this guard reads — narrow, so a unit never names `app/`. */
export interface ProjectGuardArgs {
  readonly context: { readonly queryClient: Pick<QueryClient, 'ensureQueryData'> };
  readonly params: { readonly projectId: string };
}

/**
 * Keeps the project layout from rendering for somebody the server will not show the project to
 * (STORY-014-05, acceptance 2) — the resource half of the route's guard, after the capability half
 * (`IamGuards.requirePermission`) has passed.
 *
 * **The client does not decide access; it asks.** Whether the caller holds `VIEWER` on the
 * project's chain is resolved by the use-case behind `GET /projects/{projectId}`, and the client has
 * no ACL level to resolve it with (`rules/permissions.mdc`: a second point of computing rights is
 * risk R-15). So the guard reads the card, through the same cache the screen reads, and turns the
 * server's refusal into the router's not-found.
 *
 * **403 is folded into not-found as well.** Inside the project read it means only «you hold no
 * `project:read`», which the capability guard in front of this one already answers as not-found —
 * a project is the closed contour, where the existence of the thing is the secret
 * (`IamGuards.requirePermission`, `whenDenied`). Any other failure is not an answer about the
 * project and goes to the route's error boundary, which offers a retry.
 *
 * Named for what it checks rather than `requireProjectMember` (the name in the story and in
 * `ux-architecture.md`): a `PUBLIC_ORG` project is readable by every member of the organization,
 * whether or not they are on it.
 */
export const requireProjectAccess = async (
  { context, params }: ProjectGuardArgs,
  /**
   * The switcher's «recently visited» (STORY-014-06): a project the server let through is
   * remembered here, the one place every way into a project passes — the switcher, the list, a
   * pasted link; a project it answered «not found» is forgotten, so it is not pinned again
   * (acceptance 5). A parameter, so a test holds its own store instead of the tab's.
   */
  recent: Pick<RecentProjectsStore, 'remember' | 'forget'> = recentProjects,
): Promise<void> => {
  try {
    await context.queryClient.ensureQueryData(projectDetailQueryOptions(params.projectId));
    recent.remember(params.projectId);
  } catch (error) {
    if (isApiError(error) && (error.status === HTTP_NOT_FOUND || error.status === HTTP_FORBIDDEN)) {
      recent.forget(params.projectId);
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's own signal
      throw notFound();
    }

    throw error;
  }
};
