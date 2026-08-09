import { type TeamScope, type TeamSubject } from '@/domain/iam/access/team-access.policy.js';

/** What a team is composed of, as the write path states it. Replace, never merge. */
export interface TeamDraft {
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
}

/** One row of the team list. */
export interface TeamListEntry {
  readonly teamId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  /**
   * How many people are on the team — the count, not the people.
   *
   * The same choice `RoleListEntry.holderCount` makes: the list screen asks «how big is this team»
   * before it opens one, and the names are a second read with a second permission behind it.
   */
  readonly memberCount: number;
}

/** What writing one membership actually did. */
export interface AddMemberResult {
  readonly outcome: 'created' | 'role_changed' | 'unchanged';
  /** The role held before this write — `null` for `'created'` and for `'unchanged'` alike. */
  readonly previousRole: string | null;
}

/** One membership, as the detail screen reads it. */
export interface TeamMemberEntry {
  readonly userId: string;
  /** `MEMBER` | `LEAD`, as `ck_team_members_role` constrains it. Text, like the column. */
  readonly teamRole: string;
  readonly joinedAt: Date;
}

/**
 * The name and slug of one team, with the same `isDeleted` flag `scope` carries.
 *
 * What `UpdateTeamUseCase` reads for its audit `before` — the fields the entry actually names — and
 * nothing else. Reading `detail` there instead was one Prisma `include` away from the roster on
 * every rename, of a team that could hold fifty people, for two fields the trail uses.
 */
export interface TeamSummary extends TeamScope {
  readonly name: string;
  readonly slug: string;
}

/**
 * One team and its members.
 *
 * It carries `isDeleted` and is therefore a `TeamScope`, which is deliberate: the detail read does
 * **not** filter soft-deleted rows in SQL the way the list does. A list must filter — a deleted team
 * is not a team, and a screen showing one would be wrong. A read addressed by id must not, because
 * then «this row is soft-deleted» would be decided by a `WHERE` clause instead of by the policy, and
 * the branch that answers `resource_not_found` for a disbanded team would be unreachable and
 * untestable.
 */
export interface TeamDetail extends TeamListEntry, TeamScope {
  readonly members: readonly TeamMemberEntry[];
}

/** One membership a soft deletion removed, exactly as it read before the row was gone. */
export interface DisbandedTeamMember {
  readonly userId: string;
  /** `MEMBER` | `LEAD`, as `ck_team_members_role` constrains it. Text, like the column. */
  readonly teamRole: string;
}

/**
 * What a soft deletion removed — the only record that the memberships existed.
 *
 * `members` carries the role with each id rather than a bare list of ids, and that is not
 * decoration: `team_members` has no `deleted_at`, so `team.deleted` is the one place `teamRole`
 * survives the deletion at all. `deactivate-user.use-case.ts` makes the identical choice for the
 * teams an offboarded person leaves, for the identical reason — a reviewer who has to grant
 * membership again needs a record of *what* to grant, not just *how many* people needed it.
 */
export interface DisbandedTeam {
  readonly name: string;
  readonly members: readonly DisbandedTeamMember[];
}

/**
 * Teams and their membership.
 *
 * One port rather than two, unlike roles: there is no half of this surface that a release re-applies
 * on upgrade, so the split that separates `RoleRepositoryPort` from `CustomRoleRepositoryPort` has
 * nothing to separate here.
 *
 * No method takes an `organizationId`. The tenant is the scope `withTenant` opened, and a parameter
 * beside it would be a second source of truth about which organization the caller is in — one that
 * does not fail loudly when it disagrees, because a mismatch is *filtered* by the policy rather than
 * refused (`rules/tenancy-rls.mdc`, «Ловушки», 3).
 */
export interface TeamRepositoryPort {
  /** Every live team of the organization, ordered by name. Deleted ones are not teams. */
  list(): Promise<readonly TeamListEntry[]>;

  /**
   * The two facts a decision needs, or `null` when the tenant's policy returns no row.
   *
   * Soft-deleted rows are returned, not filtered: whether a disbanded team may be addressed is the
   * policy's decision, and a `WHERE deleted_at IS NULL` here would take it away silently.
   */
  scope(teamId: string): Promise<TeamScope | null>;

  /** The same read as `scope`, plus the two fields a rename's audit `before` needs. */
  summary(teamId: string): Promise<TeamSummary | null>;

  detail(teamId: string): Promise<TeamDetail | null>;

  create(draft: TeamDraft): Promise<string>;

  /** `false` when the row went away between the decision and this write. */
  update(teamId: string, draft: TeamDraft): Promise<boolean>;

  /**
   * Soft-deletes the team and removes every membership, returning who held one.
   *
   * The memberships are deleted rather than left pointing at a hidden row: `team_members` has no
   * `deleted_at`, and a membership of a team that no longer exists is exactly the kind of state a
   * later `resolveAcl` would have to remember to filter out.
   *
   * `null` when there was nothing live to disband — the concurrent-delete window.
   */
  disband(teamId: string): Promise<DisbandedTeam | null>;

  /** The account a membership would be written for, or `null` when this tenant cannot see it. */
  subject(userId: string): Promise<TeamSubject | null>;

  /**
   * The result of writing (or trying to write) one membership.
   *
   * Three outcomes rather than the boolean the write used to answer with — the gate's L-3. A repeat
   * `POST` with the *same* role is `'unchanged'`, exactly as before: no write, no trail entry, no
   * version bump. A repeat with a *different* role is no longer folded into that same silence —
   * `'role_changed'` is the only way this API promotes an existing member to `LEAD`, since there is no
   * separate endpoint for it (`manage-team-members.use-case.ts`). `previousRole` travels with it so
   * the audit entry can say what the role *was*, not only what it became.
   */
  addMember(teamId: string, userId: string, teamRole: string): Promise<AddMemberResult>;

  /** `false` when there was no membership to remove. */
  removeMember(teamId: string, userId: string): Promise<boolean>;

  /**
   * Invalidates the folded permission view of these accounts — **one statement**, whatever the size.
   *
   * A loop in the application would be one round trip per person inside a transaction with a
   * five-second ceiling, and disbanding a fifty-person team would fail on arithmetic rather than on
   * anything being wrong.
   */
  bumpPermissionsVersionOf(userIds: readonly string[]): Promise<void>;
}
