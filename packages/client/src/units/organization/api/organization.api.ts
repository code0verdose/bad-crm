import { type MfaGate as ModelMfaGate } from '@units/organization/model';
import {
  apiClient,
  idempotencyParams,
  unwrapApiResult,
  type components,
  type operations,
} from '@shared/api';

/**
 * The organization's second-factor policy, as the contract carries it.
 *
 * `mfaRequiredSince` is read-only for this client and is never sent back: it is the server's half of
 * the countdown of acceptance 5 (a role already covered keeps the date it entered on), and a client
 * able to set it could hand itself a grace period that expired last year. The body type below is
 * what a save may contain, and it does not have the field.
 */
export type SecurityPolicy = components['schemas']['SecurityPolicy'];

/** A system role key, or the id of a custom role — a person holds the two kinds identically. */
export type PolicyRoleRef = components['schemas']['PolicyRoleRef'];

/** What a save carries, straight from the operation, so a field the server refuses will not compile. */
export type SecurityPolicyDraft =
  operations['updateSecurityPolicy']['requestBody']['content']['application/json'];

export type MfaCoverageReport =
  operations['readMfaCoverage']['responses'][200]['content']['application/json'];

export type MfaCoverageRow = MfaCoverageReport['rows'][number];

/** The four verdicts `evaluateMfaRequirement` gives, shared by the login gate and this report. */
export type MfaGate = MfaCoverageRow['gate'];

/**
 * The contract's verdicts and the screen's own list, held to each other at compile time.
 *
 * `model` may not import `api`, so the label map and the URL filter declare the four names
 * themselves. This alias is what stops the two drifting: it resolves to `true` only while the unions
 * are identical, so a fifth verdict added to `docs/api/openapi.yaml` and regenerated is a type error
 * here — rather than an untranslated word in a table and a filter that silently drops rows.
 */
type Assert<TClaim extends true> = TClaim;

export type MfaGatesAgreeWithTheModel = Assert<
  [MfaGate] extends [ModelMfaGate] ? ([ModelMfaGate] extends [MfaGate] ? true : false) : false
>;

/**
 * The stored policy.
 *
 * The `signal` is required rather than optional, for the reason every other read of this client
 * gives: a query is always cancellable, and leaving the screen while one is in flight must not
 * leave a request answering into a dead tree (`rules/tanstack-query.mdc` §4).
 */
export const fetchSecurityPolicy = async (signal: AbortSignal): Promise<SecurityPolicy> =>
  unwrapApiResult(await apiClient.GET('/organization/security-policy', { signal }));

/**
 * Replaces the policy wholesale — this is the policy, not a patch of it.
 *
 * No `signal`: issued by pressing Save behind a confirmation, so there is no later request that
 * could overtake it, and a cancelled save is worse than a slow one — the audit entry is written
 * either way and the caller would never learn whether it was.
 *
 * The key is minted per call rather than left to the middleware's default, because the contract
 * marks the header `required` and the generated types therefore demand it here — the spec making «I
 * forgot the header» a compile error rather than a 422 somebody finds by clicking.
 */
export const updateSecurityPolicy = async (draft: SecurityPolicyDraft): Promise<SecurityPolicy> => {
  const { params } = idempotencyParams();

  return unwrapApiResult(
    await apiClient.PATCH('/organization/security-policy', { params, body: draft }),
  );
};

/**
 * The draft a preview is asked about, in the two parameters the endpoint takes.
 *
 * `undefined` asks about the **stored** policy — the standing report of acceptance 9. Anything else
 * is the preview of acceptance 2, answered by the same code path the save will use, which is the
 * property the whole shape exists for: a confirmation dialog computing coverage itself is a dialog
 * that can name people the enforcement does not.
 */
export interface MfaCoverageDraft {
  readonly roles: readonly PolicyRoleRef[];
  readonly graceDays: number;
}

/**
 * Who the policy affects.
 *
 * **`graceDays` is always sent for a draft, and that is what makes an empty role list previewable.**
 * The server reads «neither parameter present» as «report on the stored policy»
 * (`security-policy.validator.ts`), and `openapi-fetch` drops an empty array entirely — so a draft
 * that switches the policy off would, without the number beside it, be answered as the policy that
 * is still stored. Switching a policy off is exactly the change somebody wants a preview of.
 */
export const fetchMfaCoverage = async (
  draft: MfaCoverageDraft | undefined,
  signal: AbortSignal,
): Promise<MfaCoverageReport> =>
  unwrapApiResult(
    await apiClient.GET('/organization/mfa-coverage', {
      params: {
        query: draft === undefined ? {} : { role: [...draft.roles], graceDays: draft.graceDays },
      },
      signal,
    }),
  );
