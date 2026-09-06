import { SharedOrganization } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import {
  evaluateMfaRequirement,
  type HeldRoleGrant,
} from '@/domain/identity/access/mfa-requirement.policy.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const day = (count: number): number => count * 24 * 60 * 60 * 1000;

const policy = (
  overrides: Partial<SharedOrganization.SecurityPolicy> = {},
): SharedOrganization.SecurityPolicy => ({
  ...SharedOrganization.DISABLED_SECURITY_POLICY,
  ...overrides,
});

const grant = (roleKey: string, grantedAt: string, roleId = `id-${roleKey}`): HeldRoleGrant => ({
  roleKey,
  roleId,
  grantedAt: new Date(grantedAt),
});

describe('evaluateMfaRequirement', () => {
  it('answers «not covered» when the policy names nobody', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy(),
      roles: [grant('admin', '2026-01-01T00:00:00.000Z')],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict).toEqual({ gate: 'not_covered', covered: false, graceEndsAtMs: undefined });
  });

  it('answers «not covered» when the person holds none of the named roles', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: ['admin'],
        mfaRequiredSince: { admin: '2026-09-01T00:00:00.000Z' },
      }),
      roles: [grant('developer', '2026-01-01T00:00:00.000Z')],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.gate).toBe('not_covered');
  });

  it('names a custom role by its id, the way the policy stores it', () => {
    const roleId = '11111111-1111-4111-8111-111111111111';

    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: [roleId],
        mfaGracePeriodDays: 0,
        mfaRequiredSince: { [roleId]: '2026-09-01T00:00:00.000Z' },
      }),
      roles: [grant('release-captain', '2026-01-01T00:00:00.000Z', roleId)],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.gate).toBe('enrollment_required');
  });

  it('is satisfied by an account that already has a second factor', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: ['admin'],
        mfaRequiredSince: { admin: '2026-01-01T00:00:00.000Z' },
      }),
      roles: [grant('admin', '2026-01-01T00:00:00.000Z')],
      hasSecondFactor: true,
      now: NOW,
    });

    expect(verdict).toEqual({
      gate: 'satisfied',
      covered: true,
      graceEndsAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });
  });

  it('leaves a covered account inside its grace period working — acceptance 4', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: ['admin'],
        mfaGracePeriodDays: 7,
        mfaRequiredSince: { admin: '2026-09-08T12:00:00.000Z' },
      }),
      roles: [grant('admin', '2026-01-01T00:00:00.000Z')],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.gate).toBe('grace');
    expect(verdict.graceEndsAtMs).toBe(Date.parse('2026-09-15T12:00:00.000Z'));
  });

  it('shuts the door the instant the grace period is up, not a day later', () => {
    const requiredSince = new Date(NOW.getTime() - day(7));

    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: ['admin'],
        mfaGracePeriodDays: 7,
        mfaRequiredSince: { admin: requiredSince.toISOString() },
      }),
      roles: [grant('admin', '2026-01-01T00:00:00.000Z')],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.gate).toBe('enrollment_required');
    expect(verdict.graceEndsAtMs).toBe(NOW.getTime());
  });

  /**
   * Acceptance 5, and the reason the policy stores a date per role rather than one for itself: the
   * countdown belongs to the pairing of a person and a role, so whichever of the two started later
   * is when it starts.
   */
  it('counts from the day the role was granted when that is later than the policy', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: ['manager'],
        mfaGracePeriodDays: 7,
        mfaRequiredSince: { manager: '2026-01-01T00:00:00.000Z' },
      }),
      roles: [grant('manager', '2026-09-09T12:00:00.000Z')],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.gate).toBe('grace');
    expect(verdict.graceEndsAtMs).toBe(Date.parse('2026-09-16T12:00:00.000Z'));
  });

  it('counts from the day the role entered the policy when that is later than the grant', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: ['manager'],
        mfaGracePeriodDays: 7,
        mfaRequiredSince: { manager: '2026-09-09T12:00:00.000Z' },
      }),
      roles: [grant('manager', '2026-01-01T00:00:00.000Z')],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.graceEndsAtMs).toBe(Date.parse('2026-09-16T12:00:00.000Z'));
  });

  it('takes the earliest of two covered roles — the requirement attached at the first of them', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: ['admin', 'manager'],
        mfaGracePeriodDays: 7,
        mfaRequiredSince: {
          admin: '2026-09-01T12:00:00.000Z',
          manager: '2026-09-09T12:00:00.000Z',
        },
      }),
      roles: [
        grant('admin', '2026-01-01T00:00:00.000Z'),
        grant('manager', '2026-01-01T00:00:00.000Z'),
      ],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.graceEndsAtMs).toBe(Date.parse('2026-09-08T12:00:00.000Z'));
    expect(verdict.gate).toBe('enrollment_required');
  });

  /**
   * A hand-edited column, or a role added to the array without its date. The grant is the strictest
   * honest answer — the alternative is a role that is in the policy and covered by no countdown.
   */
  it('falls back to the grant date when the policy carries no date for the role', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy({ mfaRequiredForRoles: ['admin'], mfaGracePeriodDays: 1 }),
      roles: [grant('admin', '2026-09-09T18:00:00.000Z')],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.gate).toBe('grace');
    expect(verdict.graceEndsAtMs).toBe(Date.parse('2026-09-10T18:00:00.000Z'));
  });

  it('falls back to the grant date when the recorded date cannot be parsed', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: ['admin'],
        mfaGracePeriodDays: 1,
        // Only something outside this codebase writes a value like this — the schema refuses it on
        // both the read and the write — which is exactly why the fallback has to be the strict one.
        mfaRequiredSince: { admin: 'the first of never' },
      }),
      roles: [grant('admin', '2026-09-09T18:00:00.000Z')],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.gate).toBe('grace');
    expect(verdict.graceEndsAtMs).toBe(Date.parse('2026-09-10T18:00:00.000Z'));
  });

  it('drops the requirement when the covering role is taken away — acceptance 5, second half', () => {
    const verdict = evaluateMfaRequirement({
      policy: policy({
        mfaRequiredForRoles: ['manager'],
        mfaRequiredSince: { manager: '2026-01-01T00:00:00.000Z' },
      }),
      roles: [],
      hasSecondFactor: false,
      now: NOW,
    });

    expect(verdict.gate).toBe('not_covered');
  });
});
