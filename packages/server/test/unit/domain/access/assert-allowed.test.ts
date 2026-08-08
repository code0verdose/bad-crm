import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { accessErrorFor, AccessRefusedError } from '@/domain/access/access.errors.js';
import { allow, assertAllowed, deny } from '@/domain/access/decision.util.js';

/**
 * Every refusal reason has one status, and the mapping is enumerated rather than assumed.
 *
 * The table below is `docs/security/permission-model.md` §5 «Fail-closed правила» plus the four
 * conflict reasons the later stories raise. It is written out here — instead of read from the
 * implementation — because a test that imports the same `Record` it is checking proves only that
 * the file parses. The `it.each` over `DENY_REASONS` at the end is what makes forgetting one
 * impossible: a reason added to the catalogue with no line in this table fails.
 */

const EXPECTED: Readonly<Record<SharedPermissions.DenyReason, { code: string; status: number }>> = {
  not_authenticated: { code: 'unauthenticated', status: 401 },
  unknown_permission: { code: 'role_forbidden', status: 403 },
  permission_not_granted: { code: 'role_forbidden', status: 403 },
  denied_by_override: { code: 'role_forbidden', status: 403 },
  resource_required: { code: 'role_forbidden', status: 403 },
  resource_not_found: { code: 'role_not_found', status: 404 },
  acl_explicit_none: { code: 'role_forbidden', status: 403 },
  insufficient_acl_level: { code: 'role_forbidden', status: 403 },
  acl_resolution_failed: { code: 'service_unavailable', status: 503 },
  tenant_mismatch: { code: 'role_not_found', status: 404 },
  vault_locked: { code: 'vault_locked', status: 423 },
  period_locked: { code: 'period_locked', status: 409 },
  last_owner_required: { code: 'last_owner_required', status: 409 },
  self_lockout: { code: 'self_lockout', status: 409 },
  self_assignment_forbidden: { code: 'role_forbidden', status: 403 },
  system_role_immutable: { code: 'system_role_immutable', status: 409 },
  invitation_already_accepted: { code: 'invitation_already_accepted', status: 409 },
  owner_immutable: { code: 'owner_immutable', status: 409 },
  // 422 rather than 409: no state of anybody else's is in conflict — the request as written
  // describes an organization that cannot exist, and the fix is a different value in the field the
  // client sent.
  manager_cycle_detected: { code: 'manager_cycle_detected', status: 422 },
  // Same shape, same reason: an employment that ends before it begins is a record that cannot
  // exist, and the database says so too — this is what keeps the answer a named 422 instead of a
  // `23514` the error handler has never heard of, i.e. a 500.
  employment_period_inverted: { code: 'employment_period_inverted', status: 422 },
};

describe('a refusal reason as an HTTP answer', () => {
  it.each(SharedPermissions.DENY_REASONS)('answers %s the way the model says', (reason) => {
    const error = accessErrorFor(reason, 'role');

    expect({ code: error.code, status: error.status }).toEqual(EXPECTED[reason]);
    expect(error.reason).toBe(reason);
  });

  it('keeps the resource out of the codes that are not about one', () => {
    // `service_unavailable` and `vault_locked` describe the installation and the session, not the
    // object: `project_service_unavailable` is not a code and must never be invented into one.
    expect(accessErrorFor('acl_resolution_failed', 'project').code).toBe('service_unavailable');
    expect(accessErrorFor('vault_locked', 'project').code).toBe('vault_locked');
  });

  it('names the resource in the codes that are', () => {
    expect(accessErrorFor('permission_not_granted', 'project').code).toBe('project_forbidden');
    expect(accessErrorFor('resource_not_found', 'project').code).toBe('project_not_found');
  });

  /**
   * Invariant 2 of CLAUDE.md, in the one place it can be stated as a property: a denial that crosses
   * organizations is a 404. Both reasons that mean "not yours or not there" answer the same, so no
   * timing-free oracle is left in the mapping itself.
   */
  it('never confirms the existence of a resource in another tenant', () => {
    expect(accessErrorFor('tenant_mismatch', 'project').status).toBe(404);
    expect(accessErrorFor('resource_not_found', 'project').status).toBe(404);
  });
});

describe('assertAllowed', () => {
  it('lets an allowed decision through', () => {
    expect(() => {
      assertAllowed(allow(), 'role');
    }).not.toThrow();
  });

  it('throws the error the reason maps to', () => {
    const thrown = ((): unknown => {
      try {
        assertAllowed(deny('insufficient_acl_level'), 'project');

        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(AccessRefusedError);
    expect((thrown as AccessRefusedError).code).toBe('project_forbidden');
    expect((thrown as AccessRefusedError).reason).toBe('insufficient_acl_level');
  });
});
