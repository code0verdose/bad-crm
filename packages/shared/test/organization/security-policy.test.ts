import { describe, expect, it } from 'vitest';

import {
  MFA_GRACE_PERIOD_DAYS_MAX,
  isPolicyEnabled,
  organizationSettingsSchema,
  readSecurityPolicy,
  securityPolicySchema,
  writeSecurityPolicy,
  DISABLED_SECURITY_POLICY,
} from '../../src/organization/security-policy.schema.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('securityPolicySchema', () => {
  it('accepts a system role key and a custom role id side by side', () => {
    const parsed = securityPolicySchema.parse({
      mfaRequiredForRoles: ['owner', 'admin', UUID],
      mfaGracePeriodDays: 7,
      mfaRequiredSince: { owner: '2026-09-06T00:00:00.000Z' },
    });

    expect(parsed.mfaRequiredForRoles).toEqual(['owner', 'admin', UUID]);
    expect(parsed.mfaGracePeriodDays).toBe(7);
  });

  it('fills both collections in when the stored object carries only a grace period', () => {
    const parsed = securityPolicySchema.parse({ mfaGracePeriodDays: 0 });

    expect(parsed.mfaRequiredForRoles).toEqual([]);
    expect(parsed.mfaRequiredSince).toEqual({});
  });

  it('refuses a role reference that is neither a system key nor a uuid', () => {
    expect(securityPolicySchema.safeParse({ mfaRequiredForRoles: ['admins'] }).success).toBe(false);
  });

  it('refuses the same role twice — two entries would give one role two start dates', () => {
    const result = securityPolicySchema.safeParse({ mfaRequiredForRoles: ['admin', 'admin'] });

    expect(result.success).toBe(false);
  });

  it.each([-1, MFA_GRACE_PERIOD_DAYS_MAX + 1, 1.5])(
    'refuses a grace period of %s days',
    (mfaGracePeriodDays) => {
      expect(securityPolicySchema.safeParse({ mfaGracePeriodDays }).success).toBe(false);
    },
  );

  it.each([0, MFA_GRACE_PERIOD_DAYS_MAX])('accepts the boundary of %s days', (days) => {
    expect(securityPolicySchema.parse({ mfaGracePeriodDays: days }).mfaGracePeriodDays).toBe(days);
  });

  it('refuses a start date that is not an instant', () => {
    const result = securityPolicySchema.safeParse({
      mfaRequiredForRoles: ['admin'],
      mfaRequiredSince: { admin: 'yesterday' },
    });

    expect(result.success).toBe(false);
  });
});

describe('readSecurityPolicy', () => {
  it('answers the disabled policy for the settings of a fresh installation', () => {
    expect(readSecurityPolicy({})).toEqual(DISABLED_SECURITY_POLICY);
    expect(isPolicyEnabled(readSecurityPolicy({}))).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'securityPolicy'],
    ['a settings object whose policy is malformed', { securityPolicy: { mfaGracePeriodDays: 99 } }],
    ['a settings object whose policy is not an object', { securityPolicy: 7 }],
  ])('answers the disabled policy for %s rather than throwing', (_case, stored) => {
    expect(readSecurityPolicy(stored)).toEqual(DISABLED_SECURITY_POLICY);
  });

  it('reads a stored policy back', () => {
    const stored = {
      securityPolicy: {
        mfaRequiredForRoles: ['admin'],
        mfaGracePeriodDays: 3,
        mfaRequiredSince: { admin: '2026-09-01T10:00:00.000Z' },
      },
    };

    const policy = readSecurityPolicy(stored);

    expect(policy.mfaRequiredForRoles).toEqual(['admin']);
    expect(policy.mfaGracePeriodDays).toBe(3);
    expect(isPolicyEnabled(policy)).toBe(true);
  });
});

describe('writeSecurityPolicy', () => {
  it('keeps every other setting the tenant root already carried', () => {
    const next = writeSecurityPolicy(
      { branding: { logoUrl: 'https://example.test/logo.svg' }, securityPolicy: {} },
      { mfaRequiredForRoles: ['owner'], mfaGracePeriodDays: 1, mfaRequiredSince: {} },
    );

    expect(next['branding']).toEqual({ logoUrl: 'https://example.test/logo.svg' });
    expect(readSecurityPolicy(next).mfaRequiredForRoles).toEqual(['owner']);
  });

  it('starts from an empty object when the stored settings are unreadable', () => {
    const next = writeSecurityPolicy('broken', DISABLED_SECURITY_POLICY);

    expect(Object.keys(next)).toEqual(['securityPolicy']);
  });
});

describe('organizationSettingsSchema', () => {
  it('keeps keys it does not know about — settings grow with other epics', () => {
    const parsed = organizationSettingsSchema.parse({ locale: 'ru', securityPolicy: {} });

    expect(parsed['locale']).toBe('ru');
  });
});
