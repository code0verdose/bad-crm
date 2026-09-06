import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  fetchMfaCoverage,
  type MfaCoverageDraft,
  type MfaCoverageReport,
} from '@units/organization/api';
import { QueryKeys } from '@shared/lib';

/**
 * Who the policy affects — the standing report, or the preview of a draft nobody has saved.
 *
 * **One query for both, because the server answers both with one function.** That is the whole
 * mechanism of acceptance 2: a confirmation dialog that computed coverage from the rows it already
 * had would be reading the report of the *stored* policy and captioning it with the draft — naming
 * people the enforcement will not touch, and missing the ones it will.
 *
 * `enabled` is required rather than defaulted, on the reasoning `useEmployeeListQuery` gives about
 * its own: the preview must be asked for only while the dialog that shows it is open, and a default
 * would let the next caller acquire a request per keystroke by not thinking about it.
 *
 * **No `keepPreviousData`, and that is the one place this screen must not have it.** It was written
 * with it, for the usual reason — a report that blinks through empty is unpleasant — and that made
 * the dialog capable of the exact lie it exists to prevent: reopened for a second draft it kept
 * answering with the first draft's numbers and names, `status` stayed `success`, and the apply button
 * stayed live under them. A skeleton for a fraction of a second is the honest state; the dialog is
 * opened deliberately and rarely.
 *
 * The `signal` is passed on, so a draft changed twice in a second cancels the first request instead
 * of racing it.
 */
export const useMfaCoverageQuery = (
  draft: MfaCoverageDraft | undefined,
  enabled: boolean,
): UseQueryResult<MfaCoverageReport, Error> =>
  useQuery({
    queryKey: QueryKeys.SecurityPolicy.coverage(
      draft === undefined ? undefined : { roles: draft.roles, graceDays: draft.graceDays },
    ),
    queryFn: ({ signal }) => fetchMfaCoverage(draft, signal),
    enabled,
    staleTime: 30_000,
  });
