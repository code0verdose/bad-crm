import { describe, expect, it } from 'vitest';

import { SharedPermissions } from '@bad-crm/shared';

import { type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { resolveFromChain } from '@/domain/access/acl-resolution.policy.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { authorizeResource } from '@/domain/access/authorize.util.js';
import { implicitLevel } from '@/domain/access/implicit-level.policy.js';
import {
  canListProjects,
  explicitLevelOn,
  isProjectVisible,
  visibleProjectsPlan,
  type ProjectVisibilityRow,
} from '@/domain/project/access/visible-projects.policy.js';
import {
  PROJECT_ROLES,
  PROJECT_VISIBILITIES,
  type ProjectRole,
  type ProjectVisibility,
} from '@/domain/project/project.enums.js';

/**
 * The single visibility function of the project list (STORY-014-03, acceptance 4; STORY-014-04,
 * acceptance 5) — proven **equal to the per-row decision**, not merely plausible.
 *
 * The reference on the right of every comparison is the composition `GetProjectDetailQuery` runs
 * for one project: the implicit table (`implicitLevel`), the chain rule over the project node and
 * the organization node (`resolveFromChain`), and the resource rung (`authorizeResource`) — the
 * three functions `can()` is made of for `project:read`. The candidate on the left is what the list
 * uses: a plan computed once per request from the organization node alone, then applied to a row
 * that carries only its visibility, the caller's membership and the level the project node's own
 * grants fold to. The two are compared over **every** combination the model has — three kinds of
 * caller (member of the organization, owner, guest), six states of the organization node, seven of
 * the project node, both visibilities, four roles and «not on it» — so a plan that disagreed with
 * `can()` on any one of 1 260 rows fails with that row named.
 *
 * Expired grants are in both sets on purpose: an expired `NONE` on the project must not hide it,
 * and an expired `VIEWER` on the organization must not open a `PRIVATE` one.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-09-26T12:00:00.000Z');
const PAST = new Date('2026-09-26T11:59:59.000Z');
const FUTURE = new Date('2026-09-27T12:00:00.000Z');

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: IVAN,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['project:read']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: ['developer'],
  ...overrides,
});

const ACTORS: readonly (readonly [string, Actor])[] = [
  ['a member of the organization', actorWith()],
  ['the owner', actorWith({ isOwner: true, permissions: new Set(), roleKeys: ['owner'] })],
  ['a guest', actorWith({ roleKeys: ['guest'] })],
];

const entry = (
  level: SharedPermissions.AccessLevel,
  expiresAt: Date | null = null,
): Omit<AclEntryOnChain, 'depth'> => ({ level, expiresAt });

type Grants = readonly Omit<AclEntryOnChain, 'depth'>[];

const ORGANIZATION_NODE: readonly (readonly [string, Grants])[] = [
  ['nothing on the organization', []],
  ['VIEWER on the organization', [entry('VIEWER')]],
  ['NONE on the organization', [entry('NONE')]],
  ['EDITOR and NONE on the organization', [entry('EDITOR'), entry('NONE', FUTURE)]],
  ['an expired VIEWER on the organization', [entry('VIEWER', PAST)]],
  ['an expired NONE on the organization', [entry('NONE', PAST)]],
];

const PROJECT_NODE: readonly (readonly [string, Grants])[] = [
  ['nothing on the project', []],
  ['VIEWER on the project', [entry('VIEWER')]],
  ['NONE on the project', [entry('NONE')]],
  ['MANAGER and NONE on the project', [entry('MANAGER'), entry('NONE')]],
  ['COMMENTER and EDITOR on the project', [entry('COMMENTER'), entry('EDITOR', FUTURE)]],
  ['an expired NONE on the project', [entry('NONE', PAST)]],
  ['an expired EDITOR on the project', [entry('EDITOR', PAST)]],
];

const MEMBERSHIPS: readonly (ProjectRole | null)[] = [...PROJECT_ROLES, null];

const at = (depth: number, grants: Grants): AclEntryOnChain[] =>
  grants.map((grant) => ({ ...grant, depth }));

/** `can(actor, 'project:read', project)` for one row — the composition the detail read runs. */
const reference = (
  actor: Actor,
  organizationGrants: Grants,
  projectGrants: Grants,
  visibility: ProjectVisibility,
  memberRole: ProjectRole | null,
): boolean => {
  const level = resolveFromChain(
    [...at(0, projectGrants), ...at(1, organizationGrants)],
    implicitLevel(actor, { resourceType: 'PROJECT', visibility, memberRole }),
    NOW,
  );

  return authorizeResource(actor, 'project:read', {
    status: 'resolved',
    organizationId: ORG,
    level,
    family: SharedPermissions.ACL_RESOURCE_FAMILY.PROJECT,
  }).allowed;
};

describe('visibleProjectsPlan + isProjectVisible ≡ can(project:read) row by row', () => {
  it.each(
    ACTORS.flatMap(([who, actor]) =>
      ORGANIZATION_NODE.map(([organizationState, grants]) => ({
        who,
        actor,
        organizationState,
        grants,
      })),
    ),
  )('$who, $organizationState', ({ actor, grants: organizationGrants }) => {
    // The organization node is read once, alone, as the list reads it — at depth 0 of a one-node
    // chain, which is exactly what `entriesAlong([{ ORGANIZATION }])` answers.
    const plan = visibleProjectsPlan(actor, at(0, organizationGrants), NOW);
    const disagreements: string[] = [];
    let visibleSomewhere = 0;
    let hiddenSomewhere = 0;

    for (const [projectState, projectGrants] of PROJECT_NODE) {
      for (const visibility of PROJECT_VISIBILITIES) {
        for (const memberRole of MEMBERSHIPS) {
          const row: ProjectVisibilityRow = {
            visibility,
            memberRole,
            explicitLevel: explicitLevelOn(at(0, projectGrants), NOW),
          };
          const expected = reference(
            actor,
            organizationGrants,
            projectGrants,
            visibility,
            memberRole,
          );

          if (expected) visibleSomewhere += 1;
          else hiddenSomewhere += 1;

          if (isProjectVisible(plan, row) !== expected) {
            disagreements.push(
              `${projectState}, ${visibility}, ${memberRole ?? 'not on it'}: can() says ${String(expected)}`,
            );
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
    // The comparison is not vacuous: every actor sees something on the grid, and everybody but the
    // owner is refused something on it.
    expect(visibleSomewhere).toBeGreaterThan(0);
    expect(hiddenSomewhere > 0).toBe(!actor.isOwner);
  });
});

describe('visibleProjectsPlan — the shape the SQL restates', () => {
  it('a member of the organization with nothing on the chain: members and PUBLIC_ORG', () => {
    const plan = visibleProjectsPlan(actorWith(), [], NOW);

    expect(plan.readableExplicitLevels).toEqual(['VIEWER', 'COMMENTER', 'EDITOR', 'MANAGER']);
    expect(plan.implicitlyVisible).toEqual([
      { visibility: 'PUBLIC_ORG', memberRole: 'LEAD' },
      { visibility: 'PUBLIC_ORG', memberRole: 'MEMBER' },
      { visibility: 'PUBLIC_ORG', memberRole: 'REVIEWER' },
      { visibility: 'PUBLIC_ORG', memberRole: 'OBSERVER' },
      { visibility: 'PUBLIC_ORG', memberRole: null },
      { visibility: 'PRIVATE', memberRole: 'LEAD' },
      { visibility: 'PRIVATE', memberRole: 'MEMBER' },
      { visibility: 'PRIVATE', memberRole: 'REVIEWER' },
      { visibility: 'PRIVATE', memberRole: 'OBSERVER' },
    ]);
  });

  it('a guest with nothing on the chain sees nothing implicitly — only an explicit grant', () => {
    const plan = visibleProjectsPlan(actorWith({ roleKeys: ['guest'] }), [], NOW);

    expect(plan.implicitlyVisible).toEqual([]);
    expect(plan.readableExplicitLevels).toEqual(['VIEWER', 'COMMENTER', 'EDITOR', 'MANAGER']);
  });

  it('NONE on the organization closes every project without its own grant', () => {
    const plan = visibleProjectsPlan(actorWith(), at(0, [entry('NONE')]), NOW);

    expect(plan.implicitlyVisible).toEqual([]);
  });

  it('the owner reads every level, NONE included — «owner неотзываем»', () => {
    const plan = visibleProjectsPlan(
      actorWith({ isOwner: true, permissions: new Set() }),
      at(0, [entry('NONE')]),
      NOW,
    );

    expect(plan.readableExplicitLevels).toEqual(SharedPermissions.ACCESS_LEVELS);
    expect(plan.implicitlyVisible).toHaveLength(PROJECT_VISIBILITIES.length * MEMBERSHIPS.length);
  });
});

describe('explicitLevelOn — the project node folded, or nothing', () => {
  it.each<[string, Grants, SharedPermissions.AccessLevel | null]>([
    ['no grants', [], null],
    ['only an expired one', [entry('MANAGER', PAST)], null],
    ['one live grant', [entry('COMMENTER')], 'COMMENTER'],
    ['the maximum of several', [entry('VIEWER'), entry('EDITOR', FUTURE)], 'EDITOR'],
    ['NONE beats everything', [entry('MANAGER'), entry('NONE')], 'NONE'],
    ['an expired NONE does not', [entry('VIEWER'), entry('NONE', PAST)], 'VIEWER'],
  ])('%s', (_case, grants, expected) => {
    expect(explicitLevelOn(at(0, grants), NOW)).toBe(expected);
  });
});

describe('canListProjects — the capability, before any row', () => {
  it('holds for a caller with project:read', () => {
    expect(canListProjects(actorWith())).toEqual({ allowed: true, reason: null });
  });

  it('holds for the owner, who holds no key by enumeration', () => {
    expect(canListProjects(actorWith({ isOwner: true, permissions: new Set() }))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it.each<[string, Actor | null, SharedPermissions.DenyReason]>([
    ['nobody signed in', null, 'not_authenticated'],
    ['no project:read', actorWith({ permissions: new Set() }), 'permission_not_granted'],
    [
      'project:read taken away by a DENY override',
      actorWith({ denied: new Set(['project:read']) }),
      'denied_by_override',
    ],
  ])('refuses %s', (_case, actor, reason) => {
    expect(canListProjects(actor)).toMatchObject({ allowed: false, reason });
  });
});
