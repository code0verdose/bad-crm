import {
  type TeamDetail,
  type TeamListEntry,
} from '@/application/iam/ports/team-repository.port.js';
import { type CreatedTeam } from '@/application/iam/use-cases/write-team.use-case.js';

/**
 * Team results → the schemas of `docs/api/openapi.yaml`.
 *
 * A whitelist, field by field, rather than a spread of the row: `isDeleted` is a fact the read path
 * carries so that the **policy** can decide on it, and a serializer that spread its input would put
 * it on the wire the day somebody added a field.
 */
export interface TeamResponse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
}

export const serializeCreatedTeam = (team: CreatedTeam): TeamResponse => ({
  id: team.teamId,
  name: team.name,
  slug: team.slug,
  description: team.description,
});

/**
 * One row of the team list.
 *
 * `memberCount`, not the members: the list screen asks «how big is this team» before it opens one,
 * and who is on it is a second read behind `GET /teams/{teamId}`.
 */
export interface TeamListEntryResponse extends TeamResponse {
  readonly memberCount: number;
}

export const serializeTeam = (team: TeamListEntry): TeamListEntryResponse => ({
  id: team.teamId,
  name: team.name,
  slug: team.slug,
  description: team.description,
  memberCount: team.memberCount,
});

/**
 * One team with its roster.
 *
 * User ids and no names. Who these people are is `GET /employees`, behind `user:read`; answering it
 * here would attach a second permission's worth of personal data to a read that only asked which
 * accounts are on a team.
 */
export interface TeamMemberResponse {
  readonly userId: string;
  readonly teamRole: string;
  readonly joinedAt: string;
}

export interface TeamDetailResponse extends TeamListEntryResponse {
  readonly members: readonly TeamMemberResponse[];
}

export const serializeTeamDetail = (team: TeamDetail): TeamDetailResponse => ({
  id: team.teamId,
  name: team.name,
  slug: team.slug,
  description: team.description,
  memberCount: team.memberCount,
  members: team.members.map((member) => ({
    userId: member.userId,
    teamRole: member.teamRole,
    joinedAt: member.joinedAt.toISOString(),
  })),
});
