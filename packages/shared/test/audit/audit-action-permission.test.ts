import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_PERMISSIONS,
  isBehindDangerousPermission,
  permissionsBehind,
  severityOf,
} from '../../src/audit/index.js';
import { PERMISSION_META } from '../../src/permissions/index.js';

/**
 * The join between the trail and the permission catalogue: which key(s) each action stands behind.
 *
 * The type already makes the map total and its keys valid, so what is asserted here is the
 * *reading* of it — the one the degradation rule on the server relies on — and a handful of rows
 * by name, because a row that quietly went wrong is exactly what the map exists to make visible.
 */
describe('which permission an audit action stands behind', () => {
  it('names at least one key for every action a permission gates, and none for the rest', () => {
    // Every entry filed by an administrator acting on somebody else stands behind a key; every
    // self-service or system entry stands behind none. Named rather than derived, because the
    // derivation would be this map read back to itself.
    const gated = AUDIT_ACTIONS.filter((action) => permissionsBehind(action).length > 0);
    const ungated = AUDIT_ACTIONS.filter((action) => permissionsBehind(action).length === 0);

    expect(gated).toContain('user.mfa_reset_by_admin');
    expect(gated).toContain('permission.inspected');
    expect(gated).toContain('team.member_added');
    expect(ungated).toContain('password.changed');
    expect(ungated).toContain('user.mfa_disabled');
    expect(ungated).toContain('organization.registered');
    expect(ungated).toContain('rls.bypassed');
    expect(ungated).toContain('access.denied');
    // CONTROL: both sides are populated, so neither assertion above passed over an empty list.
    expect(gated.length).toBeGreaterThan(0);
    expect(ungated.length).toBeGreaterThan(0);
  });

  it('reads the dangerous flag of the key, not the severity of the action', () => {
    // The row this map was written for: a quiet entry behind a dangerous key.
    expect(severityOf('permission.inspected')).toBe('INFO');
    expect(permissionsBehind('permission.inspected')).toEqual(['permission:override_read']);
    expect(PERMISSION_META['permission:override_read'].dangerous).toBe(true);
    expect(isBehindDangerousPermission('permission.inspected')).toBe(true);

    // And its mirror image: a loud entry behind an ordinary key.
    expect(severityOf('team.deleted')).toBe('WARNING');
    expect(isBehindDangerousPermission('team.deleted')).toBe(false);
  });

  /**
   * Since 2026-09-06 a team can be the subject of an ACL grant, which is why the membership
   * entries are worth asking about by name. The answer comes from the catalogue: the grant is the
   * dangerous action (`acl:grant`), joining a team is not (`team:manage_members` carries no flag),
   * so the three membership entries stand behind an ordinary key and the reading says so.
   */
  it('reads the three team-membership entries as behind an ordinary key', () => {
    for (const action of [
      'team.member_added',
      'team.member_removed',
      'team.member_role_changed',
    ] as const) {
      expect(permissionsBehind(action)).toEqual(['team:manage_members']);
      expect(isBehindDangerousPermission(action)).toBe(false);
    }
    expect(PERMISSION_META['acl:grant'].dangerous).toBe(true);
  });

  it('treats an action with two possible keys as dangerous if either one is', () => {
    expect(permissionsBehind('role.dangerous_granted')).toEqual(['role:create', 'role:update']);
    expect(PERMISSION_META['role:create'].dangerous).toBe(false);
    expect(PERMISSION_META['role:update'].dangerous).toBe(true);
    expect(isBehindDangerousPermission('role.dangerous_granted')).toBe(true);
  });

  it('carries every action of the catalogue and nothing else', () => {
    expect(Object.keys(AUDIT_ACTION_PERMISSIONS).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });
});
