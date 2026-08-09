import { apiClient, idempotencyParams, unwrapApiResult, type components } from '@shared/api';

/**
 * A team as stored — an **org-structure** entity. Nothing is granted by belonging to one: the
 * `ResourceAcl` that would make a team the subject of a grant is not part of this release, and
 * separate access groups are an open question rather than something M2 introduces
 * (`permission-model.md` §12, open question 3).
 */
export type Team = components['schemas']['Team'];

/** The whole team, not a delta: a `description` left out of an update is **cleared**. */
export type TeamDraft = components['schemas']['TeamDraft'];

/** A row of the list: the team plus how many people are on it, never who they are. */
export type TeamListEntry = components['schemas']['TeamListEntry'];

/**
 * One team with its roster.
 *
 * The members carry **user ids and no names** — who an account belongs to is `GET /employees`,
 * behind `user:read`. That is the contract refusing to attach a second permission's worth of
 * personal data to a read that asked which accounts are on a team, and it is why the screen joins
 * the directory itself when it holds the permission to.
 */
export type TeamDetail = components['schemas']['TeamDetail'];

export type TeamMember = components['schemas']['TeamMember'];

export type TeamMemberDraft = components['schemas']['TeamMemberDraft'];

/** The signal is required, not optional: this is a query, and a query is always cancellable. */
export const fetchTeams = async (signal: AbortSignal): Promise<readonly TeamListEntry[]> =>
  unwrapApiResult(await apiClient.GET('/teams', { signal })).items;

export const fetchTeam = async (teamId: string, signal: AbortSignal): Promise<TeamDetail> =>
  unwrapApiResult(await apiClient.GET('/teams/{teamId}', { params: { path: { teamId } }, signal }));

/**
 * No `signal` on any of the writes below: each is issued by pressing a button, not by a changing
 * query key, so there is no later request that could overtake it — and an option nobody passes is a
 * branch nobody tests.
 *
 * The idempotency key is minted at the call site rather than left to the middleware's default,
 * because the contract marks the header `required` and the generated types therefore demand it here
 * — the spec making «I forgot the header» a compile error instead of a duplicate team.
 */
export const createTeam = async (draft: TeamDraft): Promise<Team> => {
  const { params } = idempotencyParams();

  return unwrapApiResult(await apiClient.POST('/teams', { body: draft, params }));
};

/** Replace, not merge: the body is what the team will be. */
export const updateTeam = async (teamId: string, draft: TeamDraft): Promise<void> => {
  unwrapApiResult(
    await apiClient.PATCH('/teams/{teamId}', { params: { path: { teamId } }, body: draft }),
  );
};

/**
 * Disbands a team: the row is hidden, **every membership is removed**, and every former member's
 * permission version is bumped in the same transaction.
 */
export const deleteTeam = async (teamId: string): Promise<void> => {
  unwrapApiResult(await apiClient.DELETE('/teams/{teamId}', { params: { path: { teamId } } }));
};

/**
 * Puts somebody on a team. `teamRole: 'LEAD'` is how a team gets a lead — there is no `leadId`.
 *
 * A deactivated account is refused `409 member_not_active`: offboarding takes people off every team
 * precisely so that a suspended person is on none, and accepting them here would undo that one row
 * at a time.
 */
export const addTeamMember = async (teamId: string, draft: TeamMemberDraft): Promise<void> => {
  const { params } = idempotencyParams();

  unwrapApiResult(
    await apiClient.POST('/teams/{teamId}/members', {
      params: { ...params, path: { teamId } },
      body: draft,
    }),
  );
};

/** Takes somebody off. A membership that was not there is `404`, not a silent success. */
export const removeTeamMember = async (teamId: string, userId: string): Promise<void> => {
  unwrapApiResult(
    await apiClient.DELETE('/teams/{teamId}/members/{userId}', {
      params: { path: { teamId, userId } },
    }),
  );
};
