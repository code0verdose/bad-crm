import { type SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { type Actor } from '@/domain/access/actor.types.js';
import {
  assertMfaResetInBounds,
  assertNotSelfReset,
  type MfaResetSubject,
} from '@/domain/identity/access/mfa-policy.policy.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

const ADMIN = '018f4a3b-0000-7000-8000-00000000001a';
const COLLEAGUE = '018f4a3b-0000-7000-8000-00000000002b';
const OWNER = '018f4a3b-0000-7000-8000-00000000003c';

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: ADMIN,
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['user:reset_mfa']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const subjectWith = (overrides: Partial<MfaResetSubject> = {}): MfaResetSubject => ({
  userId: COLLEAGUE,
  isOwner: false,
  permissions: [],
  denied: [],
  ...overrides,
});

describe('assertNotSelfReset', () => {
  it('refuses an administrator resetting their own account', () => {
    expect(() => assertNotSelfReset(actorWith(), ADMIN)).toThrow(ConflictError);
  });

  it('allows an administrator resetting a colleague', () => {
    expect(() => assertNotSelfReset(actorWith(), COLLEAGUE)).not.toThrow();
  });

  it('answers self_lockout — a conflict, not a permission denial', () => {
    let caught: unknown;

    try {
      assertNotSelfReset(actorWith(), ADMIN);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).code).toBe('self_lockout');
    expect((caught as ConflictError).status).toBe(409);
  });
});

describe('assertMfaResetInBounds', () => {
  it('allows a reset when the subject holds nothing beyond the actor', () => {
    expect(() =>
      assertMfaResetInBounds(
        actorWith({ permissions: new Set(['user:reset_mfa', 'user:read']) }),
        subjectWith({ permissions: ['user:read'] }),
      ),
    ).not.toThrow();
  });

  it('refuses HIGH-1: an admin resetting the organization owner', () => {
    // The owner holds every key by construction (`SYSTEM_ROLE_PERMISSIONS.owner`), so this is also
    // caught by the subset rule below — but the owner is refused by name, on purpose (mirrors
    // `permission-override.policy.ts`'s `owner_immutable`, stated even where the subset rule would
    // already refuse, because a caller must never be one exotic permission grant away from reaching
    // the owner by accident).
    const actor = actorWith({ isOwner: false });
    const subject = subjectWith({
      userId: OWNER,
      isOwner: true,
      permissions: ['acl:grant', 'audit:export'],
    });

    let caught: unknown;

    try {
      assertMfaResetInBounds(actor, subject);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AccessRefusedError);
    expect((caught as AccessRefusedError).reason).toBe('not_the_owner');
    expect((caught as AccessRefusedError).status).toBe(403);
  });

  it('allows the owner to reset the owner-flagged subject', () => {
    // Unreachable in practice — there is one owner per organization and `assertNotSelfReset` already
    // refuses targeting oneself — but the rule is stated as "actor is not the owner", not "subject is
    // not the actor", and a table test has to cover the branch as written.
    const actor = actorWith({ isOwner: true, permissions: new Set() });
    const subject = subjectWith({ userId: OWNER, isOwner: true, permissions: ['acl:grant'] });

    expect(() => assertMfaResetInBounds(actor, subject)).not.toThrow();
  });

  it('refuses when the subject holds a permission the actor does not — T-IAM-09', () => {
    const actor = actorWith({ permissions: new Set(['user:reset_mfa']) });
    const subject = subjectWith({ permissions: ['role:update'] });

    let caught: unknown;

    try {
      assertMfaResetInBounds(actor, subject);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AccessRefusedError);
    expect((caught as AccessRefusedError).reason).toBe('permission_not_granted');
    expect((caught as AccessRefusedError).status).toBe(403);
  });

  it('does not count a permission the organization already denied the subject', () => {
    const actor = actorWith({ permissions: new Set(['user:reset_mfa']) });
    const subject = subjectWith({ permissions: ['role:update'], denied: ['role:update'] });

    expect(() => assertMfaResetInBounds(actor, subject)).not.toThrow();
  });

  it('does not count a permission the organization denied the actor as still held', () => {
    // `holdsEffectively` folds the actor's own DENY exceptions out: a right taken away from the
    // administrator must not be worked around by resetting somebody who still has it.
    const actor = actorWith({
      permissions: new Set(['user:reset_mfa', 'role:update']),
      denied: new Set(['role:update']),
    });
    const subject = subjectWith({ permissions: ['role:update'] });

    expect(() => assertMfaResetInBounds(actor, subject)).toThrow(AccessRefusedError);
  });

  it('exempts the owner from the subset rule entirely', () => {
    const actor = actorWith({ isOwner: true, permissions: new Set() });
    const subject = subjectWith({ permissions: ['acl:grant', 'audit:export', 'role:update'] });

    expect(() => assertMfaResetInBounds(actor, subject)).not.toThrow();
  });

  it('checks ownership before the subset rule, so the refusal names the real problem', () => {
    // An admin missing nothing the subject holds, aimed at the owner regardless: `not_the_owner`,
    // not `permission_not_granted` — the subset rule would be a tautology for the owner and the
    // advice it implies ("hold this permission too") leads nowhere.
    const actor = actorWith({ isOwner: false, permissions: new Set(['user:reset_mfa']) });
    const subject = subjectWith({ userId: OWNER, isOwner: true, permissions: [] });

    let caught: unknown;

    try {
      assertMfaResetInBounds(actor, subject);
    } catch (error) {
      caught = error;
    }

    expect((caught as AccessRefusedError).reason).toBe('not_the_owner');
  });
});
