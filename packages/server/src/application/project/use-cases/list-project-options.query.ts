import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import {
  type ProjectOption,
  type ProjectOptionsQueryPort,
} from '@/application/project/ports/project-options-query.port.js';
import { readProjectListViewer } from '@/application/project/project-list-viewer.util.js';
import { DEFAULT_PROJECT_LIST_STATUSES } from '@/application/project/use-cases/list-projects.query.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { canListProjects } from '@/domain/project/access/visible-projects.policy.js';
import { type ProjectStatus } from '@/domain/project/project.enums.js';

/**
 * How many projects one answer carries. Enough to scroll through without typing in an organization
 * of a few dozen projects (the target is teams of 5–50 people); beyond it the switcher says «type to
 * narrow» rather than shipping the whole organization on every open.
 */
export const PROJECT_OPTIONS_LIMIT = 50;

/** How many «recently visited» ids one request may name — the switcher pins the last five. */
export const PROJECT_OPTIONS_RECENT_MAX = 5;

const WITH_ARCHIVE: readonly ProjectStatus[] = [...DEFAULT_PROJECT_LIST_STATUSES, 'ARCHIVED'];

export interface ListProjectOptionsInput {
  readonly actor: Actor;
  /** Trimmed by the boundary; empty means «no text filter». */
  readonly query: string;
  /** STORY-014-06 acceptance 7: the archive is out unless asked for. */
  readonly includeArchived: boolean;
  /** Ids the browser remembers as recently visited; at most `PROJECT_OPTIONS_RECENT_MAX`. */
  readonly recentIds: readonly string[];
}

export interface ProjectOptionList {
  readonly items: readonly ProjectOption[];
  /** More visible projects match than `items` carries — the switcher asks the person to type. */
  readonly hasMore: boolean;
  /** Which of the asked recent ids this caller can still see, in name order. */
  readonly recent: readonly ProjectOption[];
}

/**
 * The projects the header's switcher offers — STORY-014-06 on the server.
 *
 * **The list's visibility, not a copy of it.** The capability is `canListProjects`, decided first;
 * the viewer comes from `readProjectListViewer`, the helper `ListProjectsQuery` uses; and the
 * adapter applies the plan with the same SQL prefix as the list. Whatever the list would hide — a
 * `PRIVATE` project the caller is not on, an explicit `NONE`, a deleted row — the switcher hides by
 * the same predicate, in SQL (`rules/permissions.mdc`, 8).
 *
 * **Light on purpose** (acceptance 9): five columns, no member count, no facets, no `total`. «Is
 * there more» is one extra row asked for and dropped, which costs nothing a count would not.
 *
 * **Recent ids are a question, not a list.** The browser remembers which projects were opened; the
 * server says which of them are still visible — so a project the caller lost access to drops out of
 * «recent» by the same rule that drops it from everything else, with nothing to clean up by hand.
 * They are asked without the text filter (they are what is pinned above the results before anyone
 * types) and under the same statuses, so an archived project is not pinned while the archive is off.
 */
export class ListProjectOptionsQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly acl: AclReaderPort,
    private readonly options: ProjectOptionsQueryPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {}

  execute(input: ListProjectOptionsInput): Promise<ProjectOptionList> {
    const { actor } = input;
    const statuses = input.includeArchived ? WITH_ARCHIVE : DEFAULT_PROJECT_LIST_STATUSES;

    return this.unitOfWork.withTenant(
      { organizationId: actor.organizationId, userId: actor.userId },
      async () => {
        assertAllowed(canListProjects(actor), 'project');

        const viewer = await readProjectListViewer(actor, {
          acl: this.acl,
          clock: this.clock,
          logger: this.logger,
        });
        const found = await this.options.options(viewer, {
          query: input.query,
          statuses,
          ids: null,
          limit: PROJECT_OPTIONS_LIMIT + 1,
        });
        const recent =
          input.recentIds.length === 0
            ? []
            : await this.options.options(viewer, {
                query: '',
                statuses,
                ids: input.recentIds,
                limit: input.recentIds.length,
              });

        return {
          items: found.slice(0, PROJECT_OPTIONS_LIMIT),
          hasMore: found.length > PROJECT_OPTIONS_LIMIT,
          recent,
        };
      },
    );
  }
}
