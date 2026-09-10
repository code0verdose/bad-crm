import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type Actor } from '@/domain/access/actor.types.js';
import { type AclScope } from '@/domain/access/authorize.util.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  assertProjectAddressable,
  canArchiveProject,
  canCreateProject,
  canDeleteProject,
  canManageProjectMembers,
  canManageProjectVisibility,
  canUpdateProject,
  decideProjectAccess,
  projectAclScope,
  projectAddressable,
  type ProjectAccessFacts,
  type ProjectPermissionKey,
} from '@/domain/project/access/project-access.policy.js';
import { type ProjectScope } from '@/domain/project/project.entity.js';

/**
 * Who may do what to a project — the first resource of the model (`docs/security/permission-model.md`
 * §5, the rows about `PROJECT`; §7 (а)), decided by one pure function over what two readers answered.
 *
 * What this file proves and the ladder's own test cannot: that a project is a **closed contour**.
 * Every refusal that would confirm the row exists — `NONE` on the chain, a deleted row, a row of
 * another organization, no row at all — leaves as one and the same `resource_not_found`
 * (STORY-014-03, acceptance 6), and only a refusal *inside* the contour — a level that is too low
 * for the key — is a 403 the caller may read.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const OTHER_ORG = '018f4a3b-0000-7000-8000-0000000000a2';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000d1';

const actorWith = (
  granted: readonly SharedPermissions.PermissionKey[] = ['project:read'],
  overrides: Partial<Actor> = {},
): Actor => ({
  userId: IVAN,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(granted),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: ['developer'],
  ...overrides,
});

const scopeOf = (overrides: Partial<ProjectScope> = {}): ProjectScope => ({
  projectId: PROJECT,
  isDeleted: false,
  visibility: 'PUBLIC_ORG',
  ...overrides,
});

const resolved = (level: SharedPermissions.AccessLevel, organizationId = ORG): AclScope => ({
  status: 'resolved',
  organizationId,
  level,
  family: 'standard',
});

const MISSING: AclScope = { status: 'missing' };
const UNAVAILABLE: AclScope = { status: 'unavailable' };

const facts =
  (scope: ProjectScope | null, acl: AclScope): (() => Promise<ProjectAccessFacts>) =>
  () =>
    Promise.resolve({ scope, acl });

const refused = (
  reason: SharedPermissions.DenyReason,
  key?: SharedPermissions.PermissionKey,
): Decision =>
  key === undefined ? { allowed: false, reason } : { allowed: false, reason, permissionKey: key };

describe('projectAddressable — whether the id names a project the caller may go on to address', () => {
  it.each<[string, ProjectScope | null, Decision]>([
    ['no row → resource_not_found', null, { allowed: false, reason: 'resource_not_found' }],
    [
      'a deleted row → resource_not_found, the same answer as no row',
      scopeOf({ isDeleted: true }),
      { allowed: false, reason: 'resource_not_found' },
    ],
    ['a live row → allowed', scopeOf(), { allowed: true, reason: null }],
    [
      'a live PRIVATE row → allowed: visibility is the resolver’s, not this',
      scopeOf({ visibility: 'PRIVATE' }),
      { allowed: true, reason: null },
    ],
  ])('%s', (_case, scope, expected) => {
    expect(projectAddressable(scope)).toEqual(expected);
  });

  it('asserts and narrows: after the call the row is non-null for the compiler', () => {
    const scope: ProjectScope | null = scopeOf();

    assertProjectAddressable(scope);

    expect(scope.projectId).toBe(PROJECT);
  });

  it('asserts a deleted row away as project_not_found, never as project_forbidden', () => {
    expect(() => assertProjectAddressable(scopeOf({ isDeleted: true }))).toThrow(
      expect.objectContaining({ code: 'project_not_found', reason: 'resource_not_found' }),
    );
    expect(() => assertProjectAddressable(null)).toThrow(
      expect.objectContaining({ code: 'project_not_found' }),
    );
  });
});

describe('projectAclScope — what the ladder is handed', () => {
  it.each<[string, ProjectScope | null, AclScope, AclScope]>([
    ['no row → missing, whatever the resolver said', null, resolved('MANAGER'), MISSING],
    [
      'a deleted row → missing, whatever the resolver said',
      scopeOf({ isDeleted: true }),
      resolved('MANAGER'),
      MISSING,
    ],
    [
      'a live row → the resolver’s scope, untouched',
      scopeOf(),
      resolved('EDITOR'),
      resolved('EDITOR'),
    ],
    [
      'a live row the resolver could not read → unavailable, untouched',
      scopeOf(),
      UNAVAILABLE,
      UNAVAILABLE,
    ],
    ['a live row the resolver did not find → missing', scopeOf(), MISSING, MISSING],
  ])('%s', (_case, scope, acl, expected) => {
    expect(projectAclScope({ scope, acl })).toEqual(expected);
  });
});

describe('decideProjectAccess — capability first, the readers only after', () => {
  it('refuses a caller without the key before a single fact is read', async () => {
    let read = 0;
    const decision = await decideProjectAccess(actorWith([]), 'project:read', () => {
      read += 1;

      return Promise.resolve({ scope: scopeOf(), acl: resolved('MANAGER') });
    });

    expect(decision).toEqual(refused('permission_not_granted', 'project:read'));
    expect(read).toBe(0);
  });

  it('refuses nobody in particular as not_authenticated, without reading', async () => {
    let read = 0;
    const decision = await decideProjectAccess(null, 'project:read', () => {
      read += 1;

      return Promise.resolve({ scope: scopeOf(), acl: resolved('MANAGER') });
    });

    expect(decision).toEqual(refused('not_authenticated'));
    expect(read).toBe(0);
  });

  it('refuses a DENY override before reading, and says which key', async () => {
    const actor = actorWith(['project:read'], {
      denied: new Set<SharedPermissions.PermissionKey>(['project:read']),
    });
    let read = 0;

    const decision = await decideProjectAccess(actor, 'project:read', () => {
      read += 1;

      return Promise.resolve({ scope: scopeOf(), acl: resolved('MANAGER') });
    });

    expect(decision).toEqual(refused('denied_by_override', 'project:read'));
    expect(read).toBe(0);
  });

  it('reads the facts exactly once when the capability holds', async () => {
    let read = 0;

    await decideProjectAccess(actorWith(), 'project:read', () => {
      read += 1;

      return Promise.resolve({ scope: scopeOf(), acl: resolved('VIEWER') });
    });

    expect(read).toBe(1);
  });
});

describe('decideProjectAccess — §5 over a live row, key by key', () => {
  /**
   * The implicit table and the explicit grants are already folded into the level the resolver
   * answered, so the rows below are levels rather than roles: `LEAD → MANAGER`, `MEMBER → EDITOR`,
   * `REVIEWER → COMMENTER`, `OBSERVER → VIEWER`, a bystander of a `PUBLIC_ORG` project → `VIEWER`
   * (`implicit-level-policy.test.ts` proves that mapping; this file proves what each level buys).
   */
  it.each<[SharedPermissions.AccessLevel, ProjectPermissionKey, Decision]>([
    ['VIEWER', 'project:read', { allowed: true, reason: null }],
    ['COMMENTER', 'project:read', { allowed: true, reason: null }],
    ['EDITOR', 'project:read', { allowed: true, reason: null }],
    ['MANAGER', 'project:read', { allowed: true, reason: null }],
    // `project:update` needs EDITOR: one below is refused *inside* the contour — a 403 with a reason.
    ['VIEWER', 'project:update', refused('insufficient_acl_level', 'project:update')],
    ['COMMENTER', 'project:update', refused('insufficient_acl_level', 'project:update')],
    ['EDITOR', 'project:update', { allowed: true, reason: null }],
    ['MANAGER', 'project:update', { allowed: true, reason: null }],
    // `project:delete` needs MANAGER.
    ['EDITOR', 'project:delete', refused('insufficient_acl_level', 'project:delete')],
    ['MANAGER', 'project:delete', { allowed: true, reason: null }],
  ])('level %s · %s', async (level, key, expected) => {
    const decision = await decideProjectAccess(
      actorWith([key]),
      key,
      facts(scopeOf(), resolved(level)),
    );

    expect(decision).toEqual(expected);
  });
});

describe('decideProjectAccess — the closed contour: every «not yours» is one answer', () => {
  it.each<[string, ProjectScope | null, AclScope]>([
    ['no row at all', null, MISSING],
    ['a deleted row', scopeOf({ isDeleted: true }), resolved('MANAGER')],
    ['a row of another organization', scopeOf(), resolved('MANAGER', OTHER_ORG)],
    [
      'a PRIVATE project the caller is not on → NONE on the chain',
      scopeOf({ visibility: 'PRIVATE' }),
      resolved('NONE'),
    ],
    ['an explicit NONE on a PUBLIC_ORG project', scopeOf(), resolved('NONE')],
    ['the resolver found no chain', scopeOf(), MISSING],
  ])('%s → project_not_found, never a 403', async (_case, scope, acl) => {
    const decision = await decideProjectAccess(actorWith(), 'project:read', facts(scope, acl));

    expect(decision.allowed).toBe(false);
    // The reason may differ — `tenant_mismatch` for the foreign row, `resource_not_found` for the
    // rest — and that is what the audit trail wants. What must not differ is the answer the caller
    // sees: both reasons are coded 404 (`access.errors.ts`), and only that is asserted.
    expect(['resource_not_found', 'tenant_mismatch']).toContain(decision.reason);
    expect(() => assertAllowed(decision, 'project')).toThrow(
      expect.objectContaining({ code: 'project_not_found' }),
    );
  });

  it('CONTROL: the same caller on their own PUBLIC_ORG project is allowed', async () => {
    const decision = await decideProjectAccess(
      actorWith(),
      'project:read',
      facts(scopeOf(), resolved('VIEWER')),
    );

    expect(decision).toEqual({ allowed: true, reason: null });
  });

  it('keeps the key on the remapped refusal, so the denial trail can still file it', async () => {
    const decision = await decideProjectAccess(
      actorWith(['project:delete']),
      'project:delete',
      facts(scopeOf(), resolved('NONE')),
    );

    expect(decision).toEqual(refused('resource_not_found', 'project:delete'));
  });

  it('answers a reader that failed as acl_resolution_failed — a 503, never «probably fine»', async () => {
    const decision = await decideProjectAccess(
      actorWith(),
      'project:read',
      facts(scopeOf(), UNAVAILABLE),
    );

    expect(decision).toEqual(refused('acl_resolution_failed', 'project:read'));
  });
});

describe('decideProjectAccess — the owner', () => {
  const owner = actorWith([], { isOwner: true });

  it('clears NONE on the root project: «owner неотзываем» is a stated guarantee', async () => {
    const decision = await decideProjectAccess(
      owner,
      'project:delete',
      facts(scopeOf(), resolved('NONE')),
    );

    expect(decision).toEqual({ allowed: true, reason: null });
  });

  it('does not clear a deleted row — nothing is there to own', async () => {
    const decision = await decideProjectAccess(
      owner,
      'project:read',
      facts(scopeOf({ isDeleted: true }), resolved('NONE')),
    );

    expect(decision).toEqual(refused('resource_not_found', 'project:read'));
  });

  it('does not clear a row of another organization — a foreign object is never theirs', async () => {
    const decision = await decideProjectAccess(
      owner,
      'project:read',
      facts(scopeOf(), resolved('MANAGER', OTHER_ORG)),
    );

    expect(decision).toEqual(refused('tenant_mismatch', 'project:read'));
  });
});

describe('decideProjectAccess — the guest', () => {
  /**
   * The implicit table answers `NONE` for a guest whatever the membership; that is the resolver's
   * to fold and `implicit-level-policy.test.ts` proves it. What is proved here is only the shape the
   * refusal takes once it arrives: the contour stays closed for a guest too.
   */
  it('turns the guest’s NONE into resource_not_found like anybody else’s', async () => {
    const guest = actorWith(['project:read'], { roleKeys: ['guest'] });
    const decision = await decideProjectAccess(
      guest,
      'project:read',
      facts(scopeOf(), resolved('NONE')),
    );

    expect(decision).toEqual(refused('resource_not_found', 'project:read'));
  });
});

describe('the named decisions — one per write route, each over its own key', () => {
  /**
   * The keys are read off the catalogue rather than restated: `project:create` carries no level and
   * is decided without a fact; every other key reads the level the resolver answered.
   */
  it('canCreateProject is capability-only: no fact is ever read', async () => {
    let read = 0;
    const factsRead = (): Promise<ProjectAccessFacts> => {
      read += 1;

      return Promise.resolve({ scope: scopeOf(), acl: resolved('NONE') });
    };

    expect(await canCreateProject(actorWith(['project:create']), factsRead)).toEqual({
      allowed: true,
      reason: null,
    });
    expect(await canCreateProject(actorWith([]), factsRead)).toEqual(
      refused('permission_not_granted', 'project:create'),
    );
    expect(read).toBe(0);
  });

  it.each<
    [
      string,
      (actor: Actor | null, facts: () => Promise<ProjectAccessFacts>) => Promise<Decision>,
      ProjectPermissionKey,
      SharedPermissions.AccessLevel,
      SharedPermissions.AccessLevel,
    ]
  >([
    ['canUpdateProject', canUpdateProject, 'project:update', 'EDITOR', 'COMMENTER'],
    [
      'canManageProjectVisibility',
      canManageProjectVisibility,
      'project:manage_visibility',
      'MANAGER',
      'EDITOR',
    ],
    ['canArchiveProject', canArchiveProject, 'project:archive', 'MANAGER', 'EDITOR'],
    ['canDeleteProject', canDeleteProject, 'project:delete', 'MANAGER', 'EDITOR'],
    [
      'canManageProjectMembers',
      canManageProjectMembers,
      'project:manage_members',
      'MANAGER',
      'EDITOR',
    ],
  ])('%s: the key, its level, and one below it', async (_name, decide, key, enough, tooLow) => {
    expect(await decide(actorWith([key]), facts(scopeOf(), resolved(enough)))).toEqual({
      allowed: true,
      reason: null,
    });
    expect(await decide(actorWith([key]), facts(scopeOf(), resolved(tooLow)))).toEqual(
      refused('insufficient_acl_level', key),
    );
    expect(await decide(actorWith([]), facts(scopeOf(), resolved('MANAGER')))).toEqual(
      refused('permission_not_granted', key),
    );
    // The contour stays closed for every key: a deleted row is nobody's, whatever the level.
    const gone = await decide(
      actorWith([key]),
      facts(scopeOf({ isDeleted: true }), resolved(enough)),
    );

    expect(gone).toEqual(refused('resource_not_found', key));
  });
});
