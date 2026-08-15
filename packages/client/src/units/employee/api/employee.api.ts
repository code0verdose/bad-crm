import {
  apiClient,
  idempotencyParams,
  unwrapApiResult,
  type components,
  type operations,
} from '@shared/api';

/**
 * The personnel record of one person.
 *
 * The type is the contract's, so the client cannot believe in a field the server does not send —
 * and the server sends **different shapes to different audiences**: a caller without
 * `employee:view_personal_data` receives no employment keys at all. The optional properties below
 * are that, expressed in the type system rather than in a comment.
 */
export type EmployeeProfile = components['schemas']['EmployeeProfile'];

/** What an edit carries. A PATCH: absent means «leave it», `null` means «clear it». */
export type EmployeeProfilePatch = components['schemas']['EmployeeProfilePatch'];

/** The signal is required, not optional: this is a query, and a query is always cancellable. */
export const fetchEmployeeProfile = async (
  userId: string,
  signal: AbortSignal,
): Promise<EmployeeProfile> =>
  unwrapApiResult(
    await apiClient.GET('/employees/{userId}', { params: { path: { userId } }, signal }),
  );

/** No signal: issued by pressing Save, so there is no later request that could overtake it. */
export const updateEmployeeProfile = async (
  userId: string,
  patch: EmployeeProfilePatch,
): Promise<EmployeeProfile> =>
  unwrapApiResult(
    await apiClient.PATCH('/employees/{userId}', { params: { path: { userId } }, body: patch }),
  );

/** One page of the directory, with the values its own filters can take. */
export type EmployeeDirectoryPage = components['schemas']['EmployeeDirectoryPage'];

export type EmployeeListItem = components['schemas']['EmployeeListItem'];

export type OrgChartNode = components['schemas']['OrgChartNode'];

/**
 * What the screen narrows the directory by.
 *
 * The element types come from the generated operation rather than from `string`, so a status or an
 * order the endpoint does not accept is a compile error at the call site instead of a 422 somebody
 * finds by clicking. Every field is present: the URL schema fills them all in, and «absent or the
 * thing I would have done anyway» is a branch nobody can see going wrong.
 */
type DirectoryQuery = NonNullable<operations['listEmployees']['parameters']['query']>;

export type EmployeeStatus = NonNullable<DirectoryQuery['status']>[number];
export type EmployeeSort = NonNullable<DirectoryQuery['sort']>;

export interface EmployeeListParams {
  readonly q: string;
  readonly status: readonly EmployeeStatus[];
  readonly role: readonly string[];
  readonly team: readonly string[];
  readonly sort: EmployeeSort;
  readonly page: number;
  readonly perPage: number;
}

/**
 * A page of the directory.
 *
 * The empty filters are sent as empty arrays rather than omitted: `openapi-fetch` serialises an
 * empty array to nothing at all, which is what «no filter» means here — and writing the branch at
 * the call site instead would put «is this array empty» in two places.
 */
export const fetchEmployeeList = async (
  params: EmployeeListParams,
  signal: AbortSignal,
): Promise<EmployeeDirectoryPage> =>
  unwrapApiResult(
    await apiClient.GET('/employees', {
      params: {
        query: {
          q: params.q,
          status: [...params.status],
          role: [...params.role],
          team: [...params.team],
          sort: params.sort,
          page: params.page,
          perPage: params.perPage,
        },
      },
      signal,
    }),
  );

export const fetchOrgChart = async (signal: AbortSignal): Promise<readonly OrgChartNode[]> =>
  unwrapApiResult(await apiClient.GET('/employees/org-chart', { signal })).nodes;

/** What an offboarding actually revoked, and what it could not reach. */
export type OffboardingReport = components['schemas']['OffboardingReport'];

/**
 * Switch an account off.
 *
 * No signal: issued by pressing a button behind a confirmation, so there is no later request that
 * could overtake it — and a cancelled offboarding is worse than a slow one.
 */
export const deactivateUser = async (
  userId: string,
  reason: string,
): Promise<OffboardingReport> => {
  // The key is minted per call rather than left to the middleware's default, because the contract
  // marks it `required` and the generated types therefore demand it at the call site — which is the
  // spec making «I forgot the header» a compile error instead of a duplicate offboarding.
  const { params } = idempotencyParams();

  return unwrapApiResult(
    await apiClient.POST('/users/{userId}/deactivate', {
      params: { ...params, path: { userId } },
      body: { reason },
    }),
  );
};

/** What an administrative 2FA reset actually revoked — counts rather than reassurance. */
export type ResetMfaResult = components['schemas']['ResetMfaResult'];

/**
 * Take a colleague's second factor off, when the phone and every recovery code are gone.
 *
 * **It lives here rather than in `units/iam` even though the operation is `iam`-tagged**, for the
 * same reason `deactivateUser` above does: what decides the home of a call is the screen that makes
 * it, and both are actions an administrator takes on one person from that person's personnel card.
 * `units/iam` owns roles, permissions and invitations — the things the caller may *hold* — and a
 * second unit reaching into the same card would split one screen across two public APIs.
 *
 * No signal, on the identical reasoning `deactivateUser` gives: this is issued by a button behind a
 * confirmation, so no later request can overtake it, and a cancelled reset is worse than a slow one
 * — the sessions are revoked either way and the caller would never learn whether they were.
 *
 * There is no request body. `user:reset_mfa` is the whole of the proof the server asks for: no
 * password, no code, no reason. That is what makes the confirmation dialog the only barrier there
 * is, and why it is the strict one.
 */
export const resetUserMfa = async (userId: string): Promise<ResetMfaResult> => {
  // Minted per call rather than left to the middleware's default, because the contract marks the
  // parameter `required` and the generated types therefore demand it at the call site — the spec
  // making «I forgot the header» a compile error instead of a 422 found by clicking.
  const { params } = idempotencyParams();

  return unwrapApiResult(
    await apiClient.POST('/users/{userId}/reset-mfa', { params: { ...params, path: { userId } } }),
  );
};

/** What a reactivation restored — and, in `membershipsRestored`, what it deliberately did not. */
export type ReactivationResult = components['schemas']['ReactivationResult'];

/**
 * Switch an account back on.
 *
 * The counterpart of `deactivateUser` above, and it arrives with its screen rather than before it:
 * this function was written once during STORY-012-05 and deleted unused, because a client function
 * nobody calls is a contract nobody checks. What kept the screen away until now was the personnel
 * document carrying no `status`; it does now (decision D4 of STORY-012-09), so the card can tell
 * whether there is anything to bring back.
 *
 * No signal, on the reasoning both neighbours give: this is issued by a button behind a
 * confirmation, so no later request can overtake it — and a cancelled reactivation is worse than a
 * slow one, since the account comes back either way and the caller would never learn that it had.
 *
 * There is no request body. Which account is in the path, and `user:reactivate` plus the rank rule
 * is the whole of the proof the server asks for.
 */
export const reactivateUser = async (userId: string): Promise<ReactivationResult> => {
  // Minted per call rather than left to the middleware's default, because the contract marks the
  // parameter `required` and the generated types therefore demand it at the call site — the spec
  // making «I forgot the header» a compile error instead of a 422 found by clicking.
  const { params } = idempotencyParams();

  return unwrapApiResult(
    await apiClient.POST('/users/{userId}/reactivate', { params: { ...params, path: { userId } } }),
  );
};
