import { useMemo } from 'react';

import { type DataStatus } from '@shared/ui';
import { type MfaCoverageRow, type SecurityPolicy } from '@units/organization/api';
import { filterCoverageRows } from '@units/organization/lib';
import { type OrganizationSettingsSearch } from '@units/organization/model';
import {
  useCoverageFilters,
  type CoverageFilters,
  type CoverageSearchNavigation,
} from '@units/organization/service/hooks/use-coverage-filters.hook.js';
import { useMfaCoverageQuery } from '@units/organization/service/queries';

export interface MfaCoverage {
  readonly filters: CoverageFilters;
  /** The policy the verdicts were computed against — the stored one, on this screen. */
  readonly policy: SecurityPolicy | undefined;
  /** Everybody the policy names a role of, and how many of them already have a second factor. */
  readonly covered: number;
  readonly enrolled: number;
  /** The rows after the URL's narrowing. */
  readonly rows: readonly MfaCoverageRow[];
  /** How many there were before it — what «nothing matches» has to be distinguished from. */
  readonly total: number;
  /**
   * Every role anybody in the report actually holds, sorted — what the role filter may offer.
   *
   * Derived from the answer rather than from the catalogue of system roles, so a custom role the
   * organization invented is filterable too, and a role nobody holds is not offered as a filter that
   * can only ever empty the table.
   */
  readonly roleOptions: readonly string[];
  /** The query's own three-state status, passed straight through to `DataState`. */
  readonly status: DataStatus;
  readonly refetch: () => void;
}

/**
 * The standing coverage report as one screen reads it (acceptance 9) — the unit's public API for
 * `ui` (`rules/frontend-fsd.mdc` rule 6): the table below calls this and renders, and knows nothing
 * about query keys, abort signals or the URL.
 *
 * **`undefined` as the draft, deliberately**: this is the report about the policy that is actually
 * in force, so its verdicts are the ones the login gate will give. The preview of an unsaved policy
 * is the same query with a draft, asked from the confirmation dialog.
 *
 * **`isPending`, not `isFetching`.** With `keepPreviousData` a refetch keeps the rows on screen, and
 * a skeleton over rows that are already there is a flash on every change. The first load — the one
 * with nothing to keep — is the only one that gets a skeleton.
 */
export const useMfaCoverage = (
  search: OrganizationSettingsSearch,
  navigate: CoverageSearchNavigation,
): MfaCoverage => {
  const filters = useCoverageFilters(search, navigate);
  const report = useMfaCoverageQuery(undefined, true);

  const rows = useMemo(
    () =>
      filterCoverageRows(report.data?.rows ?? [], {
        q: search.q,
        role: search.role,
        gate: search.gate,
      }),
    [report.data, search.q, search.role, search.gate],
  );

  const roleOptions = useMemo(
    () => [...new Set((report.data?.rows ?? []).flatMap((row) => row.roleKeys))].sort(),
    [report.data],
  );

  return {
    filters,
    roleOptions,
    policy: report.data?.policy,
    covered: report.data?.covered ?? 0,
    enrolled: report.data?.enrolled ?? 0,
    rows,
    total: report.data?.rows.length ?? 0,
    status: report.status,
    refetch: () => {
      void report.refetch();
    },
  };
};
