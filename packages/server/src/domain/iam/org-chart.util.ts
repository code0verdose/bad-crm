/**
 * Who reports to whom, as a question about one proposed edge.
 *
 * The whole of the org chart is not needed to answer «may this person manage that one»: what makes
 * the answer no is a path from the *proposed manager* back to the *subject*, and that path is walked
 * upwards one link at a time. Everything here is pure — the walk takes the links it is given, and
 * the caller reads them inside the transaction that will write the edge.
 */

/** `userId → managerId`, for the people who have one. */
export type ManagerLinks = ReadonlyMap<string, string>;

export interface ManagerEdge {
  readonly userId: string;
  /** `null` — this person reports to nobody, which can never form a cycle. */
  readonly managerId: string | null;
}

/**
 * Would this edge close a loop?
 *
 * Walks upwards from the proposed manager. If the walk reaches the subject, the edge would make
 * somebody their own manager at one remove — Ivan manages Pyotr, Pyotr manages Ivan — and the chart
 * stops being a tree, which every reader of it assumes it is: «кто мой руководитель» would not
 * terminate, and neither would «покажи всю ветку».
 *
 * The direct case (`manager === subject`) is caught by the database as well
 * (`ck_employee_profiles_manager_not_self`), and deliberately in both places: the constraint is what
 * makes it true of every write that ever reaches the table, and this function is what makes the
 * answer a `422` with a name rather than a `500` with a SQLSTATE.
 *
 * **A walk over links, not a recursive query.** The chart of an organization of fifty is fifty rows,
 * read once inside the transaction that is about to write; a `WITH RECURSIVE` per edit would be the
 * same answer at the cost of a query nobody can read. The `seen` set bounds the walk even when the
 * links it was handed already contain a cycle — data written before this check existed, or by a
 * migration — so a corrupt chart makes this refuse rather than hang.
 */
export const closesManagerCycle = (edge: ManagerEdge, links: ManagerLinks): boolean => {
  if (edge.managerId === null) return false;
  if (edge.managerId === edge.userId) return true;

  const seen = new Set<string>([edge.userId]);
  let current: string | undefined = edge.managerId;

  while (current !== undefined) {
    if (current === edge.userId) return true;
    // Already visited: the links themselves contain a loop. Stopping here answers «no cycle *this*
    // edge would add» — the existing one is a defect for the repair path, not for this write.
    if (seen.has(current)) return false;

    seen.add(current);
    current = links.get(current);
  }

  return false;
};
