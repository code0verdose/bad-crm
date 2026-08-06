import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  authorize,
  authorizeCapability,
  authorizeWith,
  type AclScope,
} from '@/domain/access/authorize.util.js';
import { type Actor } from '@/domain/access/actor.types.js';

/**
 * The truth table of layer 5, as a table.
 *
 * `docs/security/permission-model.md` §«Слой 5 — итоговое решение» states the algorithm and the
 * fail-closed rules; this file is that section executed. Table-driven rather than one `it` per
 * branch because the property being checked is the *shape* of the decision — every path returns a
 * `Decision` with a reason, and a path that returned a bare `false` would be invisible in prose.
 *
 * The function is pure, so there is nothing to mock and nothing that can pass for the wrong reason:
 * no clock, no database, no request. That is the whole point of putting the decision here — the one
 * place in the product where an error is silent, functional and catastrophic is authorization, and
 * this is the layer where it can be enumerated.
 */

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'user-1',
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

/** `role:read` — organization-scoped (no ACL). `project:update` — needs EDITOR. */
const ORG_SCOPED = 'role:read' as const;
const RESOURCE_SCOPED = 'project:update' as const;

describe('the capability layers (1–3)', () => {
  it('refuses an anonymous caller before looking at anything else', () => {
    expect(authorizeCapability(null, ORG_SCOPED)).toEqual({
      allowed: false,
      reason: 'not_authenticated',
    });
  });

  it('refuses a key that is not in the catalogue', () => {
    // Reachable only from a dynamic string — a route declaration is typed. Fail-closed anyway: a
    // permission deleted from the code must not become "no check at all" for whatever still sends it.
    expect(authorizeCapability(actorWith(), 'project:teleport')).toEqual({
      allowed: false,
      reason: 'unknown_permission',
    });
  });

  it('refuses when no role and no override grant it', () => {
    expect(authorizeCapability(actorWith(), ORG_SCOPED)).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('allows what a role grants', () => {
    const actor = actorWith({ permissions: new Set([ORG_SCOPED]) });

    expect(authorizeCapability(actor, ORG_SCOPED)).toEqual({ allowed: true, reason: null });
  });

  it('lets a DENY override beat an ALLOW from a role', () => {
    const actor = actorWith({ permissions: new Set([ORG_SCOPED]), denied: new Set([ORG_SCOPED]) });

    expect(authorizeCapability(actor, ORG_SCOPED)).toEqual({
      allowed: false,
      reason: 'denied_by_override',
    });
  });

  it('gives the owner everything, including what a stray DENY row forbids', () => {
    // §5: "owner неотзываем, DENY на owner запрещён на записи". A row that got there anyway — by an
    // older release, by a restore, by a bug — must not be able to lock the organization out of
    // itself, so ownership is read before the override.
    const owner = actorWith({ isOwner: true, denied: new Set([ORG_SCOPED]) });

    expect(authorizeCapability(owner, ORG_SCOPED)).toEqual({ allowed: true, reason: null });
  });
});

describe('the resource layer (4)', () => {
  const holder = actorWith({ permissions: new Set([RESOURCE_SCOPED]) });
  const scope = (level: SharedPermissions.AccessLevel): AclScope => ({
    status: 'resolved',
    organizationId: 'org-1',
    level,
    family: 'standard',
  });

  it('refuses a resource-scoped permission checked without a resource', () => {
    expect(authorize(holder, RESOURCE_SCOPED)).toEqual({
      allowed: false,
      reason: 'resource_required',
    });
  });

  it('allows the level the permission asks for, and refuses the one below it', () => {
    expect(authorize(holder, RESOURCE_SCOPED, scope('EDITOR'))).toEqual({
      allowed: true,
      reason: null,
    });
    expect(authorize(holder, RESOURCE_SCOPED, scope('COMMENTER'))).toEqual({
      allowed: false,
      reason: 'insufficient_acl_level',
    });
  });

  it('tells an explicit NONE apart from a level that is merely too low', () => {
    // Not cosmetic: `acl_explicit_none` is somebody having said "not this person", and the interface
    // offers to raise the level in one case and not in the other.
    expect(authorize(holder, RESOURCE_SCOPED, scope('NONE'))).toEqual({
      allowed: false,
      reason: 'acl_explicit_none',
    });
  });

  it('answers "not found" when the reader could not resolve the resource', () => {
    expect(authorize(holder, RESOURCE_SCOPED, { status: 'missing' })).toEqual({
      allowed: false,
      reason: 'resource_not_found',
    });
  });

  it('fails closed when the ACL could not be read at all', () => {
    expect(authorize(holder, RESOURCE_SCOPED, { status: 'unavailable' })).toEqual({
      allowed: false,
      reason: 'acl_resolution_failed',
    });
  });

  it('refuses a resource of another organization even with the level on it', () => {
    // Belt to the RLS braces: the scope should never come back with a foreign tenant, and if it
    // does — a query outside `withTenant`, a cache keyed wrongly — the decision is still no.
    const foreign: AclScope = {
      status: 'resolved',
      organizationId: 'org-2',
      level: 'MANAGER',
      family: 'standard',
    };

    expect(authorize(holder, RESOURCE_SCOPED, foreign)).toEqual({
      allowed: false,
      reason: 'tenant_mismatch',
    });
  });

  it('requires the capability as well as the level', () => {
    // The conjunction, in the direction that is easy to get wrong: MANAGER on the object grants
    // nothing on its own.
    expect(authorize(actorWith(), RESOURCE_SCOPED, scope('MANAGER'))).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  /**
   * `docs/security/permission-model.md`, «Про `isOwner` и ACL»: the owner clears the level, and the
   * document says why in one sentence — otherwise «owner неотзываем» is false, because putting NONE
   * on the root project would be enough to lock them out of their own organization. The rule is
   * checked here, in the domain, rather than left to each access reader to remember: one reader that
   * forgets is one family of objects the owner can be shut out of.
   */
  it('lets the owner past a level that would refuse anybody else, NONE included', () => {
    const owner = actorWith({ isOwner: true });

    expect(authorize(owner, RESOURCE_SCOPED, scope('VIEWER'))).toEqual({
      allowed: true,
      reason: null,
    });
    expect(authorize(owner, RESOURCE_SCOPED, scope('NONE'))).toEqual({ allowed: true, reason: null });
  });

  it('stops the owner at the vault, where a permission does not replace a key', () => {
    // The single exception the model names. Not a policy preference: the server holds no key to that
    // data at all, so «the owner may» would be a promise nothing can keep. The way in is the escrow
    // procedure (`vault:use_org_escrow`), which is a different operation with its own audit trail.
    const owner = actorWith({ isOwner: true });
    const vault: AclScope = {
      status: 'resolved',
      organizationId: 'org-1',
      level: 'VIEWER',
      family: 'vault',
    };

    expect(authorize(owner, RESOURCE_SCOPED, vault)).toEqual({
      allowed: false,
      reason: 'insufficient_acl_level',
    });
  });

  it('does not let the owner past a resource that is missing or in another tenant', () => {
    // What ownership clears is the *level*, not the existence of the object and not the tenant: an
    // owner asking for an id from another organization gets the same 404 as anybody else.
    const owner = actorWith({ isOwner: true });

    expect(authorize(owner, RESOURCE_SCOPED, { status: 'missing' })).toEqual({
      allowed: false,
      reason: 'resource_not_found',
    });
    expect(
      authorize(owner, RESOURCE_SCOPED, {
        status: 'resolved',
        organizationId: 'org-2',
        level: 'MANAGER',
        family: 'standard',
      }),
    ).toEqual({ allowed: false, reason: 'tenant_mismatch' });
  });

  it('ignores a resource passed for an organization-scoped permission', () => {
    const reader = actorWith({ permissions: new Set([ORG_SCOPED]) });

    expect(authorize(reader, ORG_SCOPED, scope('NONE'))).toEqual({ allowed: true, reason: null });
  });
});

describe('the order of the two layers', () => {
  it('does not resolve the ACL when the capability already said no', async () => {
    // Acceptance 3 of STORY-011-07 as a property of the code rather than of a query counter: the
    // resolver is the database call, and a caller without the capability must be refused before it
    // happens — both because it is a round trip nobody needs and because "no permission" and "no
    // object" must not differ in elapsed time.
    const resolve = vi.fn<() => Promise<AclScope>>();

    const decision = await authorizeWith(actorWith(), RESOURCE_SCOPED, resolve);

    expect(decision).toEqual({ allowed: false, reason: 'permission_not_granted' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not resolve the ACL for a permission that has no resource context', async () => {
    const resolve = vi.fn<() => Promise<AclScope>>();
    const reader = actorWith({ permissions: new Set([ORG_SCOPED]) });

    expect(await authorizeWith(reader, ORG_SCOPED, resolve)).toEqual({
      allowed: true,
      reason: null,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves it exactly once when the capability passed', async () => {
    const resolve = vi.fn<() => Promise<AclScope>>().mockResolvedValue({
      status: 'resolved',
      organizationId: 'org-1',
      level: 'EDITOR',
      family: 'standard',
    });
    const holder = actorWith({ permissions: new Set([RESOURCE_SCOPED]) });

    expect(await authorizeWith(holder, RESOURCE_SCOPED, resolve)).toEqual({
      allowed: true,
      reason: null,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
