import {
  type DirectoryFacets,
  type DirectorySort,
  type DirectoryStatus,
  type EmployeeDirectoryRepositoryPort,
  type EmployeeDirectoryRow,
  EMPLOYMENT_SORTS,
} from '@/application/iam/ports/employee-directory-repository.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import {
  profileAudience,
  seesEmploymentOfOthers,
  type ProfileAudience,
} from '@/domain/iam/access/employee-access.policy.js';

/**
 * The statuses a directory shows when nobody asked for any.
 *
 * A deactivated colleague is not gone — the account is suspended and never deleted, because years of
 * time entries and tasks reference it — but they are not who somebody is looking for when they open
 * a list of the people who work here. Showing them by default makes every search return an
 * ex-employee before the person meant; hiding them behind an explicit `status[]=SUSPENDED` makes
 * finding one deliberate.
 *
 * `INVITED` is in the set although no account can hold it today: an invitation that nobody has
 * accepted lives in `invitations` and has no `users` row at all (`data-model.md`, «Про
 * `User.status = INVITED`»). It is named here so that the day the value becomes reachable, the
 * default already includes it rather than quietly hiding half the directory.
 */
export const DEFAULT_DIRECTORY_STATUSES: readonly DirectoryStatus[] = ['ACTIVE', 'INVITED'];

export interface ListEmployeesInput {
  readonly actor: Actor;
  readonly filter: {
    readonly query: string;
    readonly statuses: readonly DirectoryStatus[];
    readonly roleIds: readonly string[];
    readonly teamIds: readonly string[];
    readonly sort: DirectorySort;
    readonly page: number;
    readonly perPage: number;
  };
}

/** A row plus which audiences this caller belongs to — the serializer needs both, as for one. */
export interface VisibleDirectoryRow {
  readonly row: EmployeeDirectoryRow;
  readonly audience: ProfileAudience;
}

export interface VisibleDirectoryPage {
  readonly items: readonly VisibleDirectoryRow[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly facets: DirectoryFacets;
  /**
   * How the page **is** ordered, which is not always how it was asked to be.
   *
   * Reported rather than assumed, so the screen can show the order it got instead of the one it
   * requested — a control that says «by hiring date» over a list ordered by name is a lie the user
   * discovers by counting.
   */
  readonly sort: DirectorySort;
}

const EMPLOYMENT_ORDERS = new Set<string>(EMPLOYMENT_SORTS);

/**
 * The directory of the organization: who works here, filtered and paged.
 *
 * No capability check in this body: the guard on the route did it, and a second evaluation of the
 * same capability is the second point of truth `rules/permissions.mdc` forbids. What a use-case owes
 * is the decision the guard **cannot** make, and here there are two.
 *
 * **The order can be refused.** Sorting by hiring date is a question about a column, and a caller who
 * may not read that column can still learn every value by paging a list ordered by it. So an
 * employment order asked for by somebody without `employee:view_personal_data` is answered by name
 * instead — and the answer says which order it used, rather than pretending.
 *
 * **The audience is per row, not per request.** A person's own row is theirs to read even when
 * their colleagues' rows are not, so `profileAudience` is asked once per subject. That is the same
 * function that decides one profile in STORY-012-03; there is no second implementation of «how much
 * of a personnel record is this».
 */
export class ListEmployeesQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly directory: EmployeeDirectoryRepositoryPort,
  ) {}

  async execute(input: ListEmployeesInput): Promise<VisibleDirectoryPage> {
    const sort = this.orderFor(input.actor, input.filter.sort);
    const statuses =
      input.filter.statuses.length === 0 ? DEFAULT_DIRECTORY_STATUSES : input.filter.statuses;

    return await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const page = await this.directory.list({ ...input.filter, sort, statuses });
        const facets = await this.directory.facets();

        return {
          items: page.items.map((row) => ({
            row,
            audience: profileAudience(input.actor, row.userId),
          })),
          total: page.total,
          page: input.filter.page,
          perPage: input.filter.perPage,
          facets,
          sort,
        };
      },
    );
  }

  /** An employment order the caller cannot read the values of falls back to the one anybody can. */
  private orderFor(actor: Actor, asked: DirectorySort): DirectorySort {
    if (!EMPLOYMENT_ORDERS.has(asked)) return asked;

    return seesEmploymentOfOthers(actor) ? asked : 'name';
  }
}
