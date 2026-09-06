/**
 * Which refusals reach the trail, and which stay a number — STORY-016-02, acceptance 7.
 *
 * A pure table, tested as a table. The two properties worth stating out loud:
 *
 * - the selection is **narrow on purpose**. A row per refusal would make the cheapest request an
 *   attacker can send the most expensive one we answer, so the classes that are recorded are the
 *   ones a refusal of which is evidence rather than noise;
 * - the recorded reason is **not** the `DenyReason`. Two of them answer 404 precisely so that «not
 *   yours» and «not there» are one answer, and a trail that spelled them differently would be the
 *   oracle the API refuses to be — readable, in this case, by anybody in the organization who may
 *   read the journal.
 */
import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import {
  AUDITED_DENIAL_REASON,
  recordableDenial,
} from '../../../../src/domain/access/denied-access-audit.policy.js';

/** A permission the catalogue marks dangerous, taken from the catalogue rather than typed in. */
const DANGEROUS = SharedPermissions.PERMISSIONS.find(
  (key) => SharedPermissions.PERMISSION_META[key].dangerous,
);
/** And one it does not. */
const ORDINARY = SharedPermissions.PERMISSIONS.find(
  (key) => !SharedPermissions.PERMISSION_META[key].dangerous,
);

describe('AUDITED_DENIAL_REASON', () => {
  it('CONTROL: the catalogue supplies both a dangerous and an ordinary key to test with', () => {
    expect(DANGEROUS).toBeDefined();
    expect(ORDINARY).toBeDefined();
  });

  it('covers every reason the permission model can produce', () => {
    expect(Object.keys(AUDITED_DENIAL_REASON).sort()).toEqual(
      [...SharedPermissions.DENY_REASONS].sort(),
    );
  });

  /**
   * The whole point of the collapse. `resource_not_found` and `tenant_mismatch` are the pair
   * `access.errors.ts` maps onto the same 404 so the API cannot be asked «does this id exist
   * somewhere else»; the trail has to answer the same way.
   */
  it('spells the two refusals that answer 404 identically', () => {
    expect(AUDITED_DENIAL_REASON.tenant_mismatch).toBe('not_found');
    expect(AUDITED_DENIAL_REASON.resource_not_found).toBe('not_found');
  });

  it('records nothing for an unauthenticated caller — there is no subject to name', () => {
    expect(AUDITED_DENIAL_REASON.not_authenticated).toBeNull();
  });

  it('records nothing for a state conflict — those are not refusals of access', () => {
    for (const reason of [
      'last_owner_required',
      'self_lockout',
      'system_role_immutable',
      'invitation_already_accepted',
      'period_locked',
    ] as const) {
      expect(AUDITED_DENIAL_REASON[reason], reason).toBeNull();
    }
  });

  it('records nothing when the failure was ours — an unreadable ACL is a 503, not a refusal', () => {
    expect(AUDITED_DENIAL_REASON.acl_resolution_failed).toBeNull();
  });

  /** CONTROL: the table is not simply `null` everywhere, which would pass every case above. */
  it('CONTROL: some reasons are recorded', () => {
    const recorded = Object.values(AUDITED_DENIAL_REASON).filter((value) => value !== null);

    expect(recorded.length).toBeGreaterThan(5);
  });
});

describe('recordableDenial', () => {
  it('records a refused mutation', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(
        recordableDenial({
          reason: 'permission_not_granted',
          permissionKey: ORDINARY,
          method,
        }),
        method,
      ).toEqual({ reason: 'permission_not_granted', because: 'mutating_request' });
    }
  });

  it('records a refused dangerous permission whatever the method', () => {
    expect(
      recordableDenial({ reason: 'denied_by_override', permissionKey: DANGEROUS, method: 'GET' }),
    ).toEqual({ reason: 'denied_by_override', because: 'dangerous_permission' });
  });

  /** The load-bearing negative: the cheap, floodable case leaves a counter and nothing else. */
  it('leaves an ordinary refused read to the metric', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(
        recordableDenial({
          reason: 'permission_not_granted',
          permissionKey: ORDINARY,
          method,
        }),
        method,
      ).toBeNull();
    }
  });

  it('leaves an unauthenticated refusal alone even on a mutation', () => {
    expect(
      recordableDenial({ reason: 'not_authenticated', permissionKey: undefined, method: 'POST' }),
    ).toBeNull();
  });

  it('leaves a state conflict alone even on a mutation', () => {
    expect(
      recordableDenial({
        reason: 'last_owner_required',
        permissionKey: undefined,
        method: 'DELETE',
      }),
    ).toBeNull();
  });

  it('records the collapsed reason, not the one the response carried', () => {
    expect(
      recordableDenial({
        reason: 'tenant_mismatch',
        permissionKey: ORDINARY,
        method: 'PATCH',
      })?.reason,
    ).toBe('not_found');
  });

  it('records a refusal that names no permission key when the request mutates', () => {
    expect(
      recordableDenial({ reason: 'not_the_owner', permissionKey: undefined, method: 'POST' }),
    ).toEqual({ reason: 'not_the_owner', because: 'mutating_request' });
  });
});
