import { type EmployeeListItem, type EmployeeListParams } from '@units/employee/api';
import { useEmployeeListQuery } from '@units/employee/service/queries/employee-list.query.js';

/**
 * The whole directory in one page, spelled once.
 *
 * Unpaged in effect: a hundred rows is the contract's maximum and the product's own size is five to
 * fifty people, so the first page is the organization. It is the largest page rather than a search,
 * because the answers it serves — labelling a roster, offering the people who are not on it, turning
 * an `invitedById` into a name — all need the whole of it at once, and a picker that could only find
 * somebody by typing their name first would be a picker for people you already know are there.
 *
 * **One constant rather than one per screen.** `widgets/team-detail` and `widgets/invitation-list`
 * each carried their own copy of this object with their own paragraph explaining it; two literals
 * meant to be the same cache entry are one edit away from being two.
 */
const WHOLE_DIRECTORY: EmployeeListParams = {
  q: '',
  status: [],
  role: [],
  team: [],
  sort: 'name',
  page: 1,
  perPage: 100,
};

export interface DirectorySnapshot {
  /** Everybody the read answered with — empty while it is in flight, refused, or never asked. */
  readonly people: readonly EmployeeListItem[];
  /**
   * Whether an answer actually arrived, which is not «is the list non-empty».
   *
   * A screen that offers people to pick needs the difference: an organization of one has nobody to
   * add, and a reader who may not be told has nobody to *offer*, and only the second is a reason to
   * withhold the control.
   */
  readonly isLoaded: boolean;
}

/**
 * The directory as a lookup table for screens that are about something else — the unit's public API
 * for that use (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because two screens reached past it.** Both `widgets/team-detail` and
 * `widgets/invitation-list` called `EmployeeQueries.useEmployeeListQuery(DIRECTORY, …)` themselves,
 * skipping the middle link of the chain (rule 4) and keeping the paging parameters of a read they
 * do not own.
 *
 * **`enabled` is a parameter and not a `can()` call inside.** The two callers gate this read on two
 * different rights — the team roster on `user:read`, the invitation list on `employee:read` — and
 * both are asking the same question of the same endpoint for different reasons. Deciding here which
 * right that is would be right for one caller and wrong for the other; a request certain to be
 * refused is not a graceful fallback, it is a 403 per page view.
 */
export const useDirectory = (enabled: boolean): DirectorySnapshot => {
  const query = useEmployeeListQuery(WHOLE_DIRECTORY, enabled);

  return {
    people: query.data?.items ?? [],
    isLoaded: query.data !== undefined,
  };
};
