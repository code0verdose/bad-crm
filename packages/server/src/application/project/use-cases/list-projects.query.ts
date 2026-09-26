import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import {
  type ProjectListFacets,
  type ProjectListFilter,
  type ProjectListQueryPort,
  type ProjectListSort,
  type ProjectListViewer,
} from '@/application/project/ports/project-list-query.port.js';
import { type ProjectListEntry } from '@/application/project/ports/project-repository.port.js';
import { type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { accessErrorFor } from '@/domain/access/access.errors.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  canListProjects,
  visibleProjectsPlan,
} from '@/domain/project/access/visible-projects.policy.js';
import { type ProjectStatus } from '@/domain/project/project.enums.js';

/**
 * The statuses the list shows when nobody asked for any: everything but the archive.
 *
 * STORY-014-07 acceptance 1 — an archived project «исчезает из списков … по умолчанию, остаётся
 * доступным по прямой ссылке и через фильтр `status[]=ARCHIVED`». `CLOSED` stays: a finished
 * project is still somebody's reference, and hiding it is exactly what archiving is for.
 */
export const DEFAULT_PROJECT_LIST_STATUSES: readonly ProjectStatus[] = [
  'ACTIVE',
  'ON_HOLD',
  'CLOSED',
];

export interface ListProjectsInput {
  readonly actor: Actor;
  readonly filter: {
    readonly query: string;
    /** Empty means the default of the screen, which this query — not the adapter — decides. */
    readonly statuses: readonly ProjectStatus[];
    readonly leadId: string | null;
    readonly memberOnly: boolean;
    readonly sort: ProjectListSort;
    readonly page: number;
    readonly perPage: number;
  };
}

export interface VisibleProjectPage {
  readonly items: readonly ProjectListEntry[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly sort: ProjectListSort;
  readonly facets: ProjectListFacets;
}

/**
 * The projects this caller can see, filtered and paged — STORY-014-04 on the server.
 *
 * **One decision, one set, three statements over it.** `canListProjects` is the capability, decided
 * before anything is read (`rules/permissions.mdc`, 3: the guard is a fail-fast, this is the
 * authority). The organization node of the chain is read next — one statement, whatever the number
 * of projects — and `visibleProjectsPlan` turns it into the plan every row is judged by. The page,
 * its count and the facets are then asked of the adapter with that plan, so the rows, the `total`
 * and the values of the pickers are all filtered by the same predicate in SQL
 * (`rules/permissions.mdc`, 8; STORY-011-06 acceptance 12: «множество доступных родителей
 * вычисляется один раз»). Nothing is filtered after the fetch.
 *
 * **A failed read of the organization node is a 503**, `acl_resolution_failed` — the answer the
 * resolver gives on the detail read for the same failure. An empty list would say «you have no
 * projects», a list without the grants would say more than it may; neither is «we could not check».
 *
 * A `*.query.ts` in the sense of `rules/hexagonal-backend.mdc` 7: it reads, writes nothing, and its
 * one tenant scope is the transaction the statements share. That transaction is READ COMMITTED
 * (`withTenant`'s default; `UnitOfWorkPort` offers no other), so each statement sees its own
 * snapshot: a write committed between the count and the page can make `total` disagree with the
 * rows by that write. It cannot widen what is shown — every statement applies the plan itself.
 */
export class ListProjectsQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly acl: AclReaderPort,
    private readonly list: ProjectListQueryPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {}

  execute(input: ListProjectsInput): Promise<VisibleProjectPage> {
    const { actor } = input;
    const filter: ProjectListFilter = {
      ...input.filter,
      statuses:
        input.filter.statuses.length === 0 ? DEFAULT_PROJECT_LIST_STATUSES : input.filter.statuses,
    };

    return this.unitOfWork.withTenant(
      { organizationId: actor.organizationId, userId: actor.userId },
      async () => {
        assertAllowed(canListProjects(actor), 'project');

        const viewer: ProjectListViewer = {
          userId: actor.userId,
          plan: visibleProjectsPlan(actor, await this.organizationGrants(actor), this.clock.now()),
        };
        const page = await this.list.page(viewer, filter);
        const facets = await this.list.facets(viewer);

        return {
          items: page.items,
          total: page.total,
          page: filter.page,
          perPage: filter.perPage,
          sort: filter.sort,
          facets,
        };
      },
    );
  }

  private async organizationGrants(actor: Actor): Promise<readonly AclEntryOnChain[]> {
    try {
      return await this.acl.entriesAlong(
        [{ depth: 0, type: 'ORGANIZATION', id: actor.organizationId }],
        actor.userId,
      );
    } catch (error) {
      // Logged here, as `resolve-acl.query.ts` logs the same failure on the detail read: the refusal
      // below carries a reason and no cause, and the cause is what an operator needs.
      this.logger.warn({ resourceType: 'ORGANIZATION', err: error }, 'acl resolution failed');

      throw accessErrorFor('acl_resolution_failed', 'project', undefined, 'project:read');
    }
  }
}
