import { type MfaCoverageRow } from '@units/organization/api';
import { type DataStatus } from '@shared/ui';
import { useMfaCoverageQuery } from '@units/organization/service/queries';
import { type PolicyDraft } from '@units/organization/service/hooks/use-security-policy-editor.hook.js';

export interface MfaCoveragePreview {
  readonly covered: number;
  readonly enrolled: number;
  /** Of the covered, the ones without a second factor — the names a confirmation has to show. */
  readonly missing: readonly MfaCoverageRow[];
  /**
   * The query's own three-state status, passed straight through to `DataState`.
   *
   * Not a pair of booleans the caller has to fold back into a state: two flags are three states
   * plus one that cannot happen, and a component deciding which wins is a helper living beside a
   * component (`rules/naming-and-structure.mdc` §D).
   */
  readonly status: DataStatus;
  readonly refetch: () => Promise<unknown>;
}

/**
 * What an unsaved policy would do to the organization (acceptance 2).
 *
 * **Asked of the server, with the draft as query parameters, and that is the entire point.** The
 * screen already holds the report of the policy in force, and recomputing coverage from those rows
 * would be a second implementation of `evaluateMfaRequirement` living in a dialog — one that starts
 * agreeing with the door only by luck. `GET /organization/mfa-coverage?role=…&graceDays=…` answers
 * the preview with the same function the save and the sign-in gate use, so a confirmation cannot
 * name people the enforcement will not touch.
 *
 * Only asked while `enabled` — the dialog is open — so the draft being edited behind a closed dialog
 * costs nothing.
 *
 * `missing` is derived here rather than in the dialog: «who is covered and has no second factor» is
 * the question this screen exists to answer, and it is the same three verdicts every time
 * (`grace` and `enrollment_required` are the two shapes of «not yet», `not_covered` is «not asked»).
 */
export const useMfaCoveragePreview = (draft: PolicyDraft, enabled: boolean): MfaCoveragePreview => {
  const report = useMfaCoverageQuery({ roles: draft.roles, graceDays: draft.graceDays }, enabled);

  return {
    covered: report.data?.covered ?? 0,
    enrolled: report.data?.enrolled ?? 0,
    missing: (report.data?.rows ?? []).filter(
      (row) => row.gate === 'grace' || row.gate === 'enrollment_required',
    ),
    status: report.status,
    refetch: () => report.refetch(),
  };
};
