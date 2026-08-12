import { describe, expect, it } from 'vitest';

import { OtplibTotpAdapter } from '@/infrastructure/crypto/otplib-totp.adapter.js';

/**
 * `OtplibTotpAdapter`, against RFC 6238 test vectors computed independently of `otplib`.
 *
 * The five `(epoch, code)` pairs below are **not** read out of the library or out of its own test
 * suite: they come from a from-scratch HOTP-SHA1 implementation (RFC 4226 §5.3 dynamic truncation,
 * `struct.pack('>Q', counter)`, HMAC-SHA1, `% 10**6`) run once in Python against the shared secret
 * RFC 6238 Appendix B uses for its SHA-1 vectors — the ASCII string `"12345678901234567890"`,
 * base32-encoded here as `SECRET`. RFC 6238's own published table is 8 digits; six-digit truncation
 * is `(8-digit value) mod 10**6` (10**6 divides 10**8), so the last six digits of each published
 * vector are the six-digit code at the same instant — `94287082 → 287082` for epoch 59, and so on —
 * which is what the values below actually are. If `OtplibTotpAdapter` disagreed with these, it would
 * disagree with the RFC, not merely with `otplib`.
 */

// RFC 6238 Appendix B, published in the standard itself — the opposite of a secret.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32("12345678901234567890") scan-secrets:allow gitleaks:allow

const RFC_6238_VECTORS = [
  { epoch: 59, code: '287082', counter: 1 },
  { epoch: 1_111_111_109, code: '081804', counter: 37_037_036 },
  { epoch: 1_111_111_111, code: '050471', counter: 37_037_037 },
  { epoch: 1_234_567_890, code: '005924', counter: 41_152_263 },
  { epoch: 2_000_000_000, code: '279037', counter: 66_666_666 },
] as const;

const adapter = new OtplibTotpAdapter();

const at = (epochSeconds: number): Date => new Date(epochSeconds * 1000);

describe('RFC 6238 test vectors', () => {
  it.each(RFC_6238_VECTORS)(
    'accepts the vector at epoch $epoch and reports counter $counter',
    ({ epoch, code, counter }) => {
      const result = adapter.verify({
        base32Secret: SECRET,
        code,
        at: at(epoch),
        sinceCounter: null,
      });

      expect(result).toEqual({ accepted: true, counter });
    },
  );

  it('refuses a code that does not match any accepted step', () => {
    const result = adapter.verify({
      base32Secret: SECRET,
      code: '000000',
      at: at(1_234_567_890),
      sinceCounter: null,
    });

    expect(result).toEqual({ accepted: false, replayed: false });
  });
});

/**
 * The drift window: `docs` fix it at one step either side (±30 seconds) and STORY-013-01, acceptance
 * 5 states both ends of the trade-off with concrete numbers — 25 seconds accepted, 90 refused. Both
 * codes here are computed the same independent way as the RFC vectors above, at the adjacent
 * counters of the aligned epoch 1234567890 (counter 41152263, exactly on a 30-second boundary:
 * 1234567890 / 30 = 41152263).
 */
describe('clock drift window (±30 seconds, STORY-013-01 acceptance 5)', () => {
  const serverNow = at(1_234_567_890); // counter 41152263

  it('accepts a code from a client clock 25 seconds behind (one step back)', () => {
    // counter 41152262 — the step a client would be on 25 s before the aligned boundary.
    const result = adapter.verify({
      base32Secret: SECRET,
      code: '980357',
      at: serverNow,
      sinceCounter: null,
    });

    expect(result).toEqual({ accepted: true, counter: 41_152_262 });
  });

  it('accepts a code from a client clock 25 seconds ahead (one step forward)', () => {
    // counter 41152264 — the symmetric case: `epochTolerance` is stated as a number, not a tuple.
    const result = adapter.verify({
      base32Secret: SECRET,
      code: '590587',
      at: serverNow,
      sinceCounter: null,
    });

    expect(result).toEqual({ accepted: true, counter: 41_152_264 });
  });

  it('refuses a code from a client clock 90 seconds behind (three steps back)', () => {
    // counter 41152260 — three steps behind the boundary, outside the one-step tolerance.
    const result = adapter.verify({
      base32Secret: SECRET,
      code: '798045',
      at: serverNow,
      sinceCounter: null,
    });

    expect(result).toEqual({ accepted: false, replayed: false });
  });

  it('refuses a code from a client clock 90 seconds ahead (three steps forward)', () => {
    // counter 41152266, computed the same way; the far side of the same three-step boundary.
    const result = adapter.verify({
      base32Secret: SECRET,
      code: '992085',
      at: serverNow,
      sinceCounter: null,
    });

    expect(result).toEqual({ accepted: false, replayed: false });
  });

  /**
   * The regression this suite exists to catch: at ±1 step (`TOTP_DRIFT_WINDOW_STEPS = 1`) a code
   * two steps away must be refused. The four ±1 cases above pass at ±1 *and* would keep passing at
   * a doubled window (`epochTolerance = 60`) — none of them is two steps out. Without a case at
   * exactly ±2, widening the window is a silent regression: every assertion in this file stays
   * green.
   */
  it('refuses a code from a client clock 60 seconds behind (two steps back)', () => {
    // counter 41152261 — two steps behind the boundary, inside a doubled (±2) window and outside
    // the real one-step tolerance this adapter enforces. The code is the genuine HOTP-SHA1 value at
    // this counter (computed the same independent way as the RFC vectors above) — a wrong code would
    // be refused for the wrong reason and this test would pass even after the window doubled.
    const result = adapter.verify({
      base32Secret: SECRET,
      code: '186057',
      at: serverNow,
      sinceCounter: null,
    });

    expect(result).toEqual({ accepted: false, replayed: false });
  });

  it('refuses a code from a client clock 60 seconds ahead (two steps forward)', () => {
    // counter 41152265, the symmetric two-step-forward case, same genuine-code reasoning.
    const result = adapter.verify({
      base32Secret: SECRET,
      code: '240500',
      at: serverNow,
      sinceCounter: null,
    });

    expect(result).toEqual({ accepted: false, replayed: false });
  });
});

/**
 * Anti-replay: `sinceCounter` is the last counter this account had already accepted, and a step at
 * or before it is refused even when the digits are correct (`totp.port.ts`).
 */
describe('anti-replay (sinceCounter / afterTimeStep)', () => {
  const serverNow = at(1_234_567_890); // counter 41152263
  const currentStepCode = '005924'; // counter 41152263, the RFC vector at this exact epoch

  it('refuses the exact code already accepted at this counter, and marks it as a replay', () => {
    const result = adapter.verify({
      base32Secret: SECRET,
      code: currentStepCode,
      at: serverNow,
      sinceCounter: 41_152_263,
    });

    expect(result).toEqual({ accepted: false, replayed: true });
  });

  it('refuses a code from a counter earlier than the one already accepted, marked as a replay', () => {
    const result = adapter.verify({
      base32Secret: SECRET,
      code: '980357', // counter 41152262
      at: serverNow,
      sinceCounter: 41_152_263,
    });

    expect(result).toEqual({ accepted: false, replayed: true });
  });

  it('accepts the same code when nothing has been accepted yet', () => {
    const result = adapter.verify({
      base32Secret: SECRET,
      code: currentStepCode,
      at: serverNow,
      sinceCounter: null,
    });

    expect(result).toEqual({ accepted: true, counter: 41_152_263 });
  });

  it('accepts a code one counter ahead of the last accepted one', () => {
    const result = adapter.verify({
      base32Secret: SECRET,
      code: '590587', // counter 41152264
      at: serverNow,
      sinceCounter: 41_152_263,
    });

    expect(result).toEqual({ accepted: true, counter: 41_152_264 });
  });
});

describe('generateSecret', () => {
  it('mints a base32 secret with at least 160 bits of entropy', () => {
    const { base32Secret } = adapter.generateSecret('ada@example.com');

    // Base32 with no padding: 20 raw bytes (160 bits) encode to 32 characters.
    expect(base32Secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('builds an otpauth:// URI carrying every parameter STORY-013-01 acceptance 1 names', () => {
    const { base32Secret, uri } = adapter.generateSecret('ada@example.com');
    const parsed = new URL(uri);

    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.host).toBe('totp');
    expect(decodeURIComponent(parsed.pathname)).toBe('/BadCRM:ada@example.com');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      secret: base32Secret,
      issuer: 'BadCRM',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });

  it('mints a different secret on every call', () => {
    const first = adapter.generateSecret('ada@example.com');
    const second = adapter.generateSecret('ada@example.com');

    expect(first.base32Secret).not.toBe(second.base32Secret);
  });
});
