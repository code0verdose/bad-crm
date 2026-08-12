import { describe, expect, it } from 'vitest';

import { ReadRecoveryCodeStatusQuery } from '@/application/identity/use-cases/read-recovery-code-status.query.js';

import { FakeUnitOfWork, ORGANIZATION_ID, USER_ID } from '../../support/identity-doubles.util.js';
import { FakeRecoveryCodes } from '../../support/mfa-doubles.util.js';

const ACTOR = { organizationId: ORGANIZATION_ID, userId: USER_ID };

describe('reading the recovery-code status', () => {
  it('answers total and remaining, and nothing else', async () => {
    const codes = new FakeRecoveryCodes();
    const unitOfWork = new FakeUnitOfWork();
    const query = new ReadRecoveryCodeStatusQuery(codes, unitOfWork);

    await codes.createMany(USER_ID, ['h1', 'h2', 'h3']);
    await codes.markUsed(USER_ID, [...codes.rows.keys()][0] ?? '', new Date());

    const result = await query.execute(ACTOR);

    expect(result).toEqual({ total: 3, remaining: 2 });
  });

  it('answers zero and zero when nothing has ever been issued', async () => {
    const codes = new FakeRecoveryCodes();
    const unitOfWork = new FakeUnitOfWork();
    const query = new ReadRecoveryCodeStatusQuery(codes, unitOfWork);

    await expect(query.execute(ACTOR)).resolves.toEqual({ total: 0, remaining: 0 });
  });

  it('opens the transaction on the caller’s own tenant', async () => {
    const codes = new FakeRecoveryCodes();
    const unitOfWork = new FakeUnitOfWork();
    const query = new ReadRecoveryCodeStatusQuery(codes, unitOfWork);

    await query.execute(ACTOR);

    expect(unitOfWork.scopes).toContainEqual(ACTOR);
  });
});
