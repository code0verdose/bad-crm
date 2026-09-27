import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { GetProjectDetailQuery } from '@/application/project/use-cases/get-project-detail.query.js';
import { ArchiveProjectUseCase } from '@/application/project/use-cases/archive-project.use-case.js';
import { ChangeProjectVisibilityUseCase } from '@/application/project/use-cases/change-project-visibility.use-case.js';
import { DeleteProjectUseCase } from '@/application/project/use-cases/delete-project.use-case.js';
import { AddProjectMemberUseCase } from '@/application/project/use-cases/manage-project-members.use-case.js';
import { UpdateProjectUseCase } from '@/application/project/use-cases/update-project.use-case.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type ProjectPermissions } from '@/domain/project/access/project-permissions.policy.js';
import { type ProjectRole } from '@/domain/project/project.enums.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';

import {
  ADDRESS,
  IVAN,
  OLGA,
  PETR,
  PROJECT_ID,
  actorWith,
  projectHarness,
  type ProjectHarness,
} from '../../support/project-harness.util.js';

/**
 * The `permissions` block of the project card is **the commands' own answer, asked in advance** —
 * STORY-014-05, acceptance 5 (the server half); STORY-011-08, acceptance 12.
 *
 * The reference on the right of every comparison is not a table of expected booleans written by
 * hand: it is the command itself, run on a fresh store seeded the same way, and whether it was let
 * through. A flag that answered with a different policy than its command — `canArchive` decided by
 * `project:update`, say — disagrees with the command on some row of this table, and that row is
 * red. A hand-written table would only restate what the author believed the policy says.
 *
 * The rows are the cells `test/permissions/permission-matrix.test.ts` holds for the project routes —
 * every system role — crossed with every position the caller can hold on the project: a bystander
 * of a `PUBLIC_ORG` project (`VIEWER` by the implicit table), each project role, a `PRIVATE` project
 * they are not on (`NONE` → 404), plus the two rungs above the level: the owner, and a `DENY`
 * override on one key.
 */

type Flag = keyof ProjectPermissions;

type Position =
  | { readonly label: string; readonly visibility: 'PUBLIC_ORG' | 'PRIVATE'; readonly seat: null }
  | { readonly label: string; readonly visibility: 'PUBLIC_ORG'; readonly seat: ProjectRole };

const POSITIONS: readonly Position[] = [
  { label: 'PUBLIC_ORG bystander', visibility: 'PUBLIC_ORG', seat: null },
  { label: 'OBSERVER', visibility: 'PUBLIC_ORG', seat: 'OBSERVER' },
  { label: 'REVIEWER', visibility: 'PUBLIC_ORG', seat: 'REVIEWER' },
  { label: 'MEMBER', visibility: 'PUBLIC_ORG', seat: 'MEMBER' },
  { label: 'LEAD', visibility: 'PUBLIC_ORG', seat: 'LEAD' },
  { label: 'PRIVATE, not on it', visibility: 'PRIVATE', seat: null },
];

interface Caller {
  readonly label: string;
  readonly actor: Actor;
}

const roleCaller = (role: SharedPermissions.SystemRoleKey): Caller => ({
  label: role,
  actor: actorWith(SharedPermissions.SYSTEM_ROLE_PERMISSIONS[role], {
    roleKeys: [role],
    isOwner: role === 'owner',
  }),
});

const CALLERS: readonly Caller[] = [
  ...SharedPermissions.SYSTEM_ROLE_KEYS.map(roleCaller),
  {
    label: 'admin with DENY on project:archive',
    actor: actorWith(SharedPermissions.SYSTEM_ROLE_PERMISSIONS.admin, {
      roleKeys: ['admin'],
      denied: new Set<SharedPermissions.PermissionKey>(['project:archive']),
    }),
  },
];

const seed = (position: Position): ProjectHarness =>
  projectHarness({
    visibility: position.visibility,
    members: position.seat === null ? [] : [[IVAN, position.seat]],
  });

/**
 * The command each flag promises, over its own fresh store: `true` when it went through, `false`
 * when the policy refused it (`AccessRefusedError` — the 403 and the 404 of `assertAllowed`).
 * Anything else — a conflict, a subject that cannot join — is not an answer about access and fails
 * the test loudly, because the input was chosen so that only authorization can stop it.
 */
const COMMANDS: Readonly<Record<Flag, (harness: ProjectHarness, actor: Actor) => Promise<void>>> = {
  canEdit: (h, actor) =>
    new UpdateProjectUseCase(h.unitOfWork, h.store, h.store, h.acl, h.audit).execute({
      actor,
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
      name: 'Renamed',
      description: null,
      // The lead the harness seeded: an unchanged lead is `project:update` alone, which is the
      // decision `canEdit` names. A changed lead demands `project:manage_members` on top — that is
      // `canManageMembers`, held below by its own command.
      leadId: PETR,
      startedAt: null,
      dueAt: null,
      color: 'teal',
    }),
  canManageMembers: (h, actor) =>
    new AddProjectMemberUseCase(h.unitOfWork, h.store, h.store, h.acl, h.audit).execute({
      actor,
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
      userId: OLGA,
      projectRole: 'MEMBER',
      allocationPct: 50,
    }),
  canChangeVisibility: (h, actor) =>
    new ChangeProjectVisibilityUseCase(h.unitOfWork, h.store, h.acl, h.audit).execute({
      actor,
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
      // Confirmed, so that the `428` a permitted caller would otherwise get cannot stand in for an
      // answer about access. On a `PRIVATE` seed this is the no-op repeat — after the decision.
      visibility: 'PRIVATE',
      confirmedDangerous: true,
    }),
  canArchive: (h, actor) =>
    new ArchiveProjectUseCase(h.unitOfWork, h.store, h.acl, h.audit).execute({
      actor,
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
    }),
  canDelete: (h, actor) =>
    new DeleteProjectUseCase(h.unitOfWork, h.store, h.store, h.acl, h.audit).execute({
      actor,
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
    }),
};

const FLAGS = Object.keys(COMMANDS) as Flag[];

/** What a caller who cannot read the project may do to it. */
const NOTHING: ProjectPermissions = {
  canEdit: false,
  canManageMembers: false,
  canChangeVisibility: false,
  canArchive: false,
  canDelete: false,
};

const commandOutcome = async (flag: Flag, position: Position, actor: Actor): Promise<boolean> => {
  try {
    await COMMANDS[flag](seed(position), actor);

    return true;
  } catch (error) {
    if (error instanceof AccessRefusedError) return false;

    throw error;
  }
};

const card = (position: Position, actor: Actor) => {
  const harness = seed(position);

  return new GetProjectDetailQuery(harness.unitOfWork, harness.store, harness.acl).execute({
    actor,
    projectId: PROJECT_ID,
  });
};

const ROWS = CALLERS.flatMap((caller) => POSITIONS.map((position) => ({ caller, position }))).map(
  ({ caller, position }) => [`${caller.label} · ${position.label}`, caller, position] as const,
);

describe('the permissions block of the project card', () => {
  it.each(ROWS)('%s: every flag is what its command decides', async (_label, caller, position) => {
    const outcomes = Object.fromEntries(
      await Promise.all(
        FLAGS.map(
          async (flag) => [flag, await commandOutcome(flag, position, caller.actor)] as const,
        ),
      ),
    ) as Record<Flag, boolean>;

    const read = await card(position, caller.actor).then(
      (project) => project,
      (error: unknown) => {
        if (error instanceof AccessRefusedError) return null;

        throw error;
      },
    );

    // No card means no block — and then no command may succeed either: a button with nowhere to be
    // drawn must not be a route that answers 204.
    expect(outcomes).toEqual(read === null ? NOTHING : read.permissions);
  });

  /**
   * The table above would be vacuous if every flag answered the same thing on every row: a block
   * hard-coded to `false` agrees with a command that refuses everybody. This holds that each flag
   * takes both values somewhere in the table, and that the flags are not all one decision — the
   * rows where `canEdit` and `canArchive` differ are the rows that tell `project:update` from
   * `project:archive`.
   */
  it('CONTROL: each flag is true on some row and false on another, and the flags are not one decision', async () => {
    const seen = new Map<Flag, Set<boolean>>(FLAGS.map((flag) => [flag, new Set<boolean>()]));
    const signatures = new Set<string>();

    for (const [, caller, position] of ROWS) {
      const project = await card(position, caller.actor).catch(() => null);

      if (project === null) continue;

      for (const flag of FLAGS) seen.get(flag)?.add(project.permissions[flag]);
      signatures.add(`${project.permissions.canEdit}/${project.permissions.canArchive}`);
    }

    for (const flag of FLAGS)
      expect([flag, [...(seen.get(flag) ?? [])].sort()]).toEqual([flag, [false, true]]);
    expect(signatures).toContain('true/false');
  });

  it('decides the flags over the facts the read already holds — no statement is added', async () => {
    const harness = seed(POSITIONS[4] as Position);

    await new GetProjectDetailQuery(harness.unitOfWork, harness.store, harness.acl).execute({
      actor: roleCaller('admin').actor,
      projectId: PROJECT_ID,
    });

    // One `scope`, one chain, one entity — the same trace as before the block existed. Five more
    // decisions over a memoized read cost nothing; a second read here would be the N+1 of a card.
    expect(harness.store.trace.filter((call) => call === 'scope')).toHaveLength(1);
    expect(harness.store.trace.filter((call) => call === 'detail')).toHaveLength(1);
    expect(harness.store.chains).toHaveLength(1);
  });
});
