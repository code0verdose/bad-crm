import { describe, expect, it } from 'vitest';

import { rateLimitKeyOf } from '@/infrastructure/rate-limit/rate-limit-key.util.js';

const EMAIL = 'Ada.Lovelace@Example.COM';
const IP = '203.0.113.42';

describe('rate limit key', () => {
  it('keys an authentication attempt on the pair, not on either half', () => {
    const both = rateLimitKeyOf('auth_attempt', { ipAddress: IP, email: EMAIL }).value;
    const otherEmail = rateLimitKeyOf('auth_attempt', {
      ipAddress: IP,
      email: 'grace@example.com',
    }).value;
    const otherIp = rateLimitKeyOf('auth_attempt', {
      ipAddress: '198.51.100.7',
      email: EMAIL,
    }).value;

    expect(both).not.toBe(otherEmail);
    expect(both).not.toBe(otherIp);
  });

  it('gives the same key for the same pair written differently', () => {
    expect(
      rateLimitKeyOf('auth_attempt', { ipAddress: IP, email: '  ADA.lovelace@example.com ' }).value,
    ).toBe(rateLimitKeyOf('auth_attempt', { ipAddress: IP, email: EMAIL }).value);
  });

  it('never carries the address in clear, in the key or in the label', () => {
    const key = rateLimitKeyOf('auth_attempt', { ipAddress: IP, email: EMAIL });

    expect(`${key.value} ${key.label}`.toLowerCase()).not.toContain('ada.lovelace');
    expect(`${key.value} ${key.label}`.toLowerCase()).not.toContain('example.com');
  });

  it('labels the attempt with a masked network and a digest, both stable', () => {
    const key = rateLimitKeyOf('auth_attempt', { ipAddress: IP, email: EMAIL });
    const again = rateLimitKeyOf('auth_attempt', { ipAddress: IP, email: EMAIL });

    expect(key.label).toContain('203.0.113.0/24');
    expect(key.label).toMatch(/email=sha256:[0-9a-f]{16}\b/);
    expect(again.label).toBe(key.label);
  });

  it('puts every request without a readable address into one stated bucket', () => {
    const missing = rateLimitKeyOf('auth_attempt', { ipAddress: undefined, email: EMAIL });
    const unreadable = rateLimitKeyOf('auth_attempt', {
      ipAddress: 'not-an-address',
      email: EMAIL,
    });

    expect(missing.value).toBe(unreadable.value);
    expect(missing.label).toContain('unknown');
  });

  it('separates the counters of two policies for the same subject', () => {
    expect(rateLimitKeyOf('organization_registration', { ipAddress: IP }).value).not.toBe(
      rateLimitKeyOf('api_request', { ipAddress: IP, userId: undefined }).value,
    );
  });

  it('prefers the authenticated actor over the address on the shared API limit', () => {
    const byUser = rateLimitKeyOf('api_request', {
      userId: '01JQ0000000000000000000001',
      ipAddress: IP,
    });
    const byOtherAddress = rateLimitKeyOf('api_request', {
      userId: '01JQ0000000000000000000001',
      ipAddress: '198.51.100.7',
    });

    expect(byUser.value).toBe(byOtherAddress.value);
    expect(byUser.label).toContain('01JQ0000000000000000000001');
  });

  it('keys a heavy operation on the user alone', () => {
    const key = rateLimitKeyOf('heavy_operation', { userId: '01JQ0000000000000000000002' });

    expect(key.value).toContain('heavy_operation');
    expect(key.label).toContain('01JQ0000000000000000000002');
  });
});

describe('mfa verify attempt — keyed on the mfaToken jti, not on a userId', () => {
  it('gives two tokens different keys and the same token the same key twice', () => {
    const tokenA = rateLimitKeyOf('mfa_verify_attempt', { jti: 'jti-aaaa' }).value;
    const tokenB = rateLimitKeyOf('mfa_verify_attempt', { jti: 'jti-bbbb' }).value;
    const tokenAAgain = rateLimitKeyOf('mfa_verify_attempt', { jti: 'jti-aaaa' }).value;

    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).toBe(tokenAAgain);
  });

  it('carries the jti in the label, the same way a userId is carried unmasked', () => {
    const key = rateLimitKeyOf('mfa_verify_attempt', { jti: 'jti-aaaa' });

    expect(key.label).toContain('jti-aaaa');
  });
});

describe('mfa recovery consume attempt — keyed on the pair, not on the userId alone', () => {
  const USER_ID = '01JQ0000000000000000000009';
  const OTHER_USER_ID = '01JQ0000000000000000000010';
  const OTHER_IP = '198.51.100.7';

  it('changes when the address changes for the same user — the case the old UserSubject key missed', () => {
    const first = rateLimitKeyOf('mfa_recovery_consume_attempt', {
      userId: USER_ID,
      ipAddress: IP,
    }).value;
    const second = rateLimitKeyOf('mfa_recovery_consume_attempt', {
      userId: USER_ID,
      ipAddress: OTHER_IP,
    }).value;

    expect(first).not.toBe(second);
  });

  it('changes when the user changes for the same address', () => {
    const first = rateLimitKeyOf('mfa_recovery_consume_attempt', {
      userId: USER_ID,
      ipAddress: IP,
    }).value;
    const second = rateLimitKeyOf('mfa_recovery_consume_attempt', {
      userId: OTHER_USER_ID,
      ipAddress: IP,
    }).value;

    expect(first).not.toBe(second);
  });

  it('puts every request without a readable address into one shared bucket, not one per malformed value', () => {
    const missing = rateLimitKeyOf('mfa_recovery_consume_attempt', {
      userId: USER_ID,
      ipAddress: undefined,
    }).value;
    const unreadable = rateLimitKeyOf('mfa_recovery_consume_attempt', {
      userId: USER_ID,
      ipAddress: 'not-an-address',
    }).value;

    expect(missing).toBe(unreadable);
  });
});

describe('actor subject regression — unaffected by the pair-subject rendering', () => {
  it('still prefers the authenticated user over the address on the shared API limit', () => {
    const byUser = rateLimitKeyOf('api_request', { userId: 'user-1', ipAddress: IP }).value;
    const byOtherAddress = rateLimitKeyOf('api_request', {
      userId: 'user-1',
      ipAddress: '198.51.100.9',
    }).value;

    expect(byUser).toBe(byOtherAddress);
  });

  it('still falls back to the address when there is no user, on client_error_report', () => {
    const anonA = rateLimitKeyOf('client_error_report', {
      userId: undefined,
      ipAddress: IP,
    }).value;
    const anonB = rateLimitKeyOf('client_error_report', {
      userId: undefined,
      ipAddress: '198.51.100.9',
    }).value;

    expect(anonA).not.toBe(anonB);
  });
});
