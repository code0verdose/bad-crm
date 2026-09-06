import { type MfaGate } from '@units/organization/model';

/**
 * The part of a report row this narrowing reads.
 *
 * Structural rather than the contract's own `MfaCoverageRow`, because `lib` may not import `api`
 * (`test/architecture/layers.test.ts`) — and because a filter has no business knowing what else a
 * row carries. Every real row satisfies it, which the call site type-checks.
 */
export interface CoverageSubject {
  readonly email: string;
  readonly roleKeys: readonly string[];
  readonly gate: MfaGate;
}

/** The narrowing the URL carries, in the shape the search schema produces it. */
export interface CoverageFilter {
  readonly q: string;
  readonly role: readonly string[];
  readonly gate: readonly MfaGate[];
}

/**
 * The rows the screen shows, out of the rows the server sent.
 *
 * Filtering happens here rather than in SQL because the contract says so:
 * `GET /organization/mfa-coverage` answers with every active account and is deliberately unpaged, so
 * that «how many are not enrolled» is not a second request that can disagree with the first
 * (`docs/api/openapi.yaml`, `readMfaCoverage`). That is the one case `rules/lists-and-filters.mdc`
 * leaves to the client, and it holds only because the report is bounded by the size of the
 * organization.
 *
 * **An empty selection is «everything», never «nothing».** It is the state the screen opens in, and
 * a filter that started by hiding every row would read as a report about an organization with no
 * people in it.
 *
 * The two multi-selects are an AND of ORs: any of the chosen roles, and any of the chosen verdicts.
 * A person selected under «admin» and «grace» holds `admin` *and* is inside their grace period —
 * which is the question an administrator asks, «who is still not covered among the people I named».
 *
 * `toLowerCase`, deliberately not `toLocaleLowerCase`: under a Turkish or Azeri host locale the
 * latter folds `I` to `ı`, and a correctly typed address would stop matching its own row.
 */
export const filterCoverageRows = <TRow extends CoverageSubject>(
  rows: readonly TRow[],
  filter: CoverageFilter,
): readonly TRow[] => {
  const phrase = filter.q.trim().toLowerCase();

  return rows.filter(
    (row) =>
      (phrase === '' || row.email.toLowerCase().includes(phrase)) &&
      (filter.role.length === 0 || row.roleKeys.some((key) => filter.role.includes(key))) &&
      (filter.gate.length === 0 || filter.gate.includes(row.gate)),
  );
};
