import { describe, expect, it } from 'vitest';

import { SetupTotpUseCase } from '@/application/identity/use-cases/setup-totp.use-case.js';
import {
  MfaAlreadyEnabledError,
  RateLimitedError,
  UnauthenticatedError,
} from '@/domain/shared/errors/app.errors.js';

import {
  FakeClock,
  FakeRateLimit,
  FakeUnitOfWork,
  FakeUsers,
  ORGANIZATION_ID,
  USER_ID,
} from '../../support/identity-doubles.util.js';
import {
  FakeFieldEncryption,
  FakeQrCode,
  FakeTotpEnrollment,
  ScriptedTotp,
} from '../../support/mfa-doubles.util.js';

const ACTOR = { organizationId: ORGANIZATION_ID, userId: USER_ID };

const buildHarness = () => {
  const users = new FakeUsers([
    {
      id: USER_ID,
      email: 'ada@example.com',
      locale: 'en',
      timezone: 'UTC',
      status: 'ACTIVE',
      permissionsVersion: 1,
    },
  ]);
  const enrollment = new FakeTotpEnrollment();
  const totp = new ScriptedTotp();
  const qr = new FakeQrCode();
  const fields = new FakeFieldEncryption();
  const unitOfWork = new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit({ limits: { mfa_setup_attempt: 5 } });
  const clock = new FakeClock();

  return {
    useCase: new SetupTotpUseCase(
      users,
      enrollment,
      totp,
      qr,
      fields,
      unitOfWork,
      rateLimit,
      clock,
    ),
    users,
    enrollment,
    totp,
    qr,
    fields,
    unitOfWork,
    rateLimit,
    clock,
  };
};

describe('drafting a TOTP secret', () => {
  it('writes a draft that does not enable 2FA', async () => {
    const harness = buildHarness();

    const result = await harness.useCase.execute({ actor: ACTOR });

    expect(result.base32Secret).toMatch(/^SECRET1FOR/);
    expect(result.uri).toContain(result.base32Secret);

    const state = await harness.enrollment.find(USER_ID);

    expect(state?.enabledAt).toBeNull();
    expect(state?.draftExpiresAt).not.toBeNull();
  });

  it('encrypts the secret before writing it — the stored value is never the plaintext', async () => {
    const harness = buildHarness();

    const result = await harness.useCase.execute({ actor: ACTOR });
    const state = await harness.enrollment.find(USER_ID);

    expect(state?.secretEnc).not.toBe(result.base32Secret);
    expect(harness.fields.decrypt(state?.secretEnc ?? null)).toBe(result.base32Secret);
  });

  it('renders the otpauth URI as a QR code and returns the manual-entry text too', async () => {
    const harness = buildHarness();

    const result = await harness.useCase.execute({ actor: ACTOR });

    expect(harness.qr.rendered).toEqual([result.uri]);
    expect(result.qrSvg).toContain(result.uri);
  });

  it('opens the transaction on the caller’s own tenant', async () => {
    const harness = buildHarness();

    await harness.useCase.execute({ actor: ACTOR });

    expect(harness.unitOfWork.scopes).toContainEqual(ACTOR);
  });

  it('sets the draft expiry fifteen minutes ahead of the clock', async () => {
    const harness = buildHarness();

    await harness.useCase.execute({ actor: ACTOR });
    const state = await harness.enrollment.find(USER_ID);

    expect(state?.draftExpiresAt?.getTime()).toBe(harness.clock.now().getTime() + 15 * 60 * 1000);
  });

  it('issues a fresh secret on a second call while still unconfirmed, overwriting the first', async () => {
    const harness = buildHarness();

    const first = await harness.useCase.execute({ actor: ACTOR });
    const second = await harness.useCase.execute({ actor: ACTOR });

    expect(second.base32Secret).not.toBe(first.base32Secret);

    const state = await harness.enrollment.find(USER_ID);

    expect(harness.fields.decrypt(state?.secretEnc ?? null)).toBe(second.base32Secret);
  });
});

describe('refusing a second setup once 2FA is enabled', () => {
  it('answers mfa_already_enabled and touches nothing', async () => {
    const harness = buildHarness();

    const draftExpiresAt = new Date(harness.clock.now().getTime() + 60_000);

    await harness.enrollment.beginDraft(USER_ID, 'enc:already', draftExpiresAt);
    await harness.enrollment.commitEnrollment(USER_ID, 1, harness.clock.now());

    await expect(harness.useCase.execute({ actor: ACTOR })).rejects.toBeInstanceOf(
      MfaAlreadyEnabledError,
    );
    expect(harness.qr.rendered).toEqual([]);
  });
});

describe('an account that no longer exists', () => {
  it('refuses rather than drafting a secret for nobody', async () => {
    const harness = buildHarness();

    harness.users.rows.clear();

    await expect(harness.useCase.execute({ actor: ACTOR })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe('the rate limit', () => {
  it('bounds repeated setup calls under the mfa_setup_attempt budget, same as confirm', async () => {
    const harness = buildHarness();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.useCase.execute({ actor: ACTOR });
    }

    await expect(harness.useCase.execute({ actor: ACTOR })).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('does not reset the budget on a successful draft', async () => {
    const harness = buildHarness();

    await harness.useCase.execute({ actor: ACTOR });

    expect(harness.rateLimit.cleared).toEqual([]);
  });
});
