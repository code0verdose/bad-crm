import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import {
  judgeRoleChanges,
  type ActorHoldings,
  type RoleChange,
} from '@/domain/iam/access/role-batch.policy.js';

/**
 * A screenful of edits decided **together**, which is the whole difference from
 * `role-composition.policy.ts`.
 *
 * The matrix screen saves a draft: a dozen cells across several roles, applied in one transaction.
 * Judging each change as if it were alone gets one thing wrong, and it is exactly the thing the
 * administrator is doing on purpose — moving a right **from** one role **to** another. The first
 * half of that move removes the actor's last source of `role:update`; the second half puts it back.
 * A per-change rule refuses the batch; the correct rule looks at what the actor holds once every
 * change has been applied.
 *
 * So the policy takes the whole draft and answers per change, and the self-lockout question is asked
 * once, against the end state.
 */

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'admin',
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>([
    'role:read',
    'role:update',
    'role:delete',
    'task:read',
    'task:update',
  ]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const change = (overrides: Partial<RoleChange> = {}): RoleChange => ({
  roleId: 'role-1',
  key: 'tech_writer',
  isSystem: false,
  before: ['task:read'],
  after: ['task:read', 'task:update'],
  ...overrides,
});

const holdings = (overrides: Partial<ActorHoldings> = {}): ActorHoldings => ({
  byRole: new Map<string, readonly SharedPermissions.PermissionKey[]>(),
  fromOverrides: new Set<SharedPermissions.PermissionKey>(),
  ...overrides,
});

const verdicts = (
  actor: Actor,
  changes: readonly RoleChange[],
  held: ActorHoldings = holdings(),
): Record<string, string | null> =>
  Object.fromEntries(
    judgeRoleChanges(actor, changes, held).map((verdict) => [verdict.roleId, verdict.reason]),
  );

describe('judging a draft', () => {
  it('allows changes made of what the author holds', () => {
    expect(verdicts(actorWith(), [change()])).toEqual({ 'role-1': null });
  });

  it('refuses a change that would grant what the author lacks', () => {
    expect(verdicts(actorWith(), [change({ after: ['user:impersonate'] })])).toEqual({
      'role-1': 'permission_not_granted',
    });
  });

  it('refuses a change to a system role', () => {
    expect(verdicts(actorWith(), [change({ isSystem: true })])).toEqual({
      'role-1': 'system_role_immutable',
    });
  });

  it('judges each change on its own merits, not the batch as a whole', () => {
    // One bad cell must not condemn the eleven good ones — the screen has to be able to say which
    // one it was, and «the draft is refused» is not an answer anybody can act on.
    const draft = [change(), change({ roleId: 'role-2', after: ['user:impersonate'] })];

    expect(verdicts(actorWith(), draft)).toEqual({
      'role-1': null,
      'role-2': 'permission_not_granted',
    });
  });
});

describe('the capability to save at all', () => {
  it('refuses every change to somebody who may look but not edit', () => {
    // The preview runs under `role:read`, and its answer is «would the server accept this». For an
    // actor without `role:update` the honest answer is no, for every cell — otherwise the screen
    // offers a Save that is refused a second later.
    const reader = actorWith({ permissions: new Set(['role:read', 'task:read', 'task:update']) });

    expect(verdicts(reader, [change(), change({ roleId: 'role-2' })])).toEqual({
      'role-1': 'permission_not_granted',
      'role-2': 'permission_not_granted',
    });
  });

  it('still reports what the change would do, so the screen can explain itself', () => {
    const reader = actorWith({ permissions: new Set(['role:read', 'task:read', 'task:update']) });
    const [verdict] = judgeRoleChanges(reader, [change()], holdings());

    expect(verdict).toMatchObject({ added: ['task:update'], removed: [] });
  });
});

describe('the lockout question, asked against the end state', () => {
  const held = (roleId: string, permissions: SharedPermissions.PermissionKey[]): ActorHoldings =>
    holdings({ byRole: new Map([[roleId, permissions]]) });

  it('refuses a draft that leaves the author unable to edit roles', () => {
    const draft = [change({ before: ['role:update'], after: ['task:read'] })];

    expect(verdicts(actorWith(), draft, held('role-1', ['role:update']))).toEqual({
      'role-1': 'self_lockout',
    });
  });

  /**
   * The move the per-change rule gets wrong, and the reason this policy exists: `role:update` leaves
   * the role the author holds and lands in another role they also hold. Judged one at a time, the
   * first half is a lockout; judged together, nothing was lost.
   */
  it('allows moving the right from one role the author holds to another', () => {
    const draft = [
      change({ roleId: 'role-1', before: ['role:update'], after: ['task:read'] }),
      change({ roleId: 'role-2', before: ['task:read'], after: ['task:read', 'role:update'] }),
    ];
    const both = holdings({
      byRole: new Map([
        ['role-1', ['role:update'] as SharedPermissions.PermissionKey[]],
        ['role-2', ['task:read'] as SharedPermissions.PermissionKey[]],
      ]),
    });

    expect(verdicts(actorWith(), draft, both)).toEqual({ 'role-1': null, 'role-2': null });
  });

  it('counts a personal ALLOW exception as a source the author keeps', () => {
    const draft = [change({ before: ['role:update'], after: ['task:read'] })];
    const byException = holdings({
      byRole: new Map([['role-1', ['role:update'] as SharedPermissions.PermissionKey[]]]),
      fromOverrides: new Set<SharedPermissions.PermissionKey>(['role:update']),
    });

    expect(verdicts(actorWith(), draft, byException)).toEqual({ 'role-1': null });
  });

  it('ignores roles the author does not hold', () => {
    // Somebody else's role losing `role:update` is not the author's problem to be protected from —
    // the author keeps it from the role they do hold, which the draft does not touch.
    const draft = [change({ before: ['role:update'], after: ['task:read'] })];
    const elsewhere = holdings({
      byRole: new Map([['role-9', ['role:update'] as SharedPermissions.PermissionKey[]]]),
    });

    expect(verdicts(actorWith(), draft, elsewhere)).toEqual({ 'role-1': null });
  });

  it('blames the change that removes the right, not the rest of the draft', () => {
    const draft = [
      change({ roleId: 'role-1', before: ['role:update'], after: ['task:read'] }),
      change({ roleId: 'role-2', before: ['task:read'], after: ['task:read', 'task:update'] }),
    ];
    const both = holdings({
      byRole: new Map([
        ['role-1', ['role:update'] as SharedPermissions.PermissionKey[]],
        ['role-2', ['task:read'] as SharedPermissions.PermissionKey[]],
      ]),
    });

    expect(verdicts(actorWith(), draft, both)).toEqual({
      'role-1': 'self_lockout',
      // Untouched by the refusal next door: the screen has to be able to point at the cell.
      'role-2': null,
    });
  });

  it.each([
    ['role:update', ['role:delete', 'task:read']],
    ['role:delete', ['role:update', 'task:read']],
  ])('protects %s on its own, not just the pair', (removed, kept) => {
    // Both keys of `GOVERNS_RIGHTS`, one at a time. The single-role policy pins them separately
    // (`role-composition-policy.test.ts`), and the two lists are supposed to stay in step — which is
    // only true while both files actually check both keys.
    const draft = [change({ before: [removed as SharedPermissions.PermissionKey], after: [] })];
    const held = holdings({
      byRole: new Map([['role-1', [removed] as SharedPermissions.PermissionKey[]]]),
      fromOverrides: new Set(kept as SharedPermissions.PermissionKey[]),
    });

    expect(verdicts(actorWith(), draft, held)).toEqual({ 'role-1': 'self_lockout' });
  });

  it('does not protect a right the organization already took away', () => {
    // Mirror of the single-role case: `role:delete` is denied to this actor, so a change removing it
    // from their own role takes away nothing they could still use.
    const denied = actorWith({
      denied: new Set<SharedPermissions.PermissionKey>(['role:delete']),
    });
    const draft = [change({ before: ['role:delete'], after: ['task:read'] })];
    const held = holdings({
      byRole: new Map([['role-1', ['role:delete'] as SharedPermissions.PermissionKey[]]]),
      fromOverrides: new Set<SharedPermissions.PermissionKey>(['role:update']),
    });

    expect(verdicts(denied, draft, held)).toEqual({ 'role-1': null });
  });

  it('blames only the role the actor holds when two of them drop the same right', () => {
    // The other half of «point at the cell»: a role the actor does not hold, losing the same key,
    // is not their lockout to be refused for.
    const draft = [
      change({ roleId: 'role-1', before: ['role:update'], after: [] }),
      change({ roleId: 'role-2', before: ['role:update'], after: [] }),
    ];
    const holdsSecond = holdings({
      byRole: new Map([['role-2', ['role:update'] as SharedPermissions.PermissionKey[]]]),
    });

    expect(verdicts(actorWith(), draft, holdsSecond)).toEqual({
      'role-1': null,
      'role-2': 'self_lockout',
    });
  });

  it('never locks out the owner', () => {
    const owner = actorWith({ isOwner: true, permissions: new Set() });
    const draft = [change({ before: ['role:update'], after: [] })];

    expect(verdicts(owner, draft, held('role-1', ['role:update']))).toEqual({ 'role-1': null });
  });
});

describe('what a draft changes', () => {
  it('names the keys added, removed and newly dangerous', () => {
    const [verdict] = judgeRoleChanges(
      actorWith({ permissions: new Set(['role:update', 'user:impersonate', 'task:read']) }),
      [change({ before: ['task:read', 'task:update'], after: ['task:read', 'user:impersonate'] })],
      holdings(),
    );

    expect(verdict).toMatchObject({
      added: ['user:impersonate'],
      removed: ['task:update'],
      // Only the ones arriving: a key that was already in the role is not a new decision, and a
      // warning about it would be noise on every save of a role that has one.
      dangerous: ['user:impersonate'],
    });
  });

  it('reports nothing dangerous when the dangerous key was already there', () => {
    const [verdict] = judgeRoleChanges(
      actorWith({ permissions: new Set(['role:update', 'user:impersonate', 'task:read']) }),
      [change({ before: ['user:impersonate'], after: ['user:impersonate', 'task:read'] })],
      holdings(),
    );

    expect(verdict).toMatchObject({ added: ['task:read'], removed: [], dangerous: [] });
  });
});
