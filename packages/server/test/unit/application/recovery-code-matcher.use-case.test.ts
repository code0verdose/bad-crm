import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RecoveryCodeMatcher } from '@/application/identity/use-cases/recovery-code-matcher.use-case.js';

import { FakePasswordHasher, USER_ID } from '../../support/identity-doubles.util.js';
import { FakeRecoveryCodes } from '../../support/mfa-doubles.util.js';

const seedCode = (codes: FakeRecoveryCodes, plaintext: string): string => {
  const id = randomUUID();

  codes.rows.set(id, {
    id,
    userId: USER_ID,
    codeHash: `$argon2id$hashed:${plaintext}`,
    usedAt: null,
  });

  return id;
};

describe('matching a code without spending it', () => {
  it('returns the id of the row whose hash verifies', async () => {
    const codes = new FakeRecoveryCodes();
    const hasher = new FakePasswordHasher();
    const matcher = new RecoveryCodeMatcher(codes, hasher);

    const id = seedCode(codes, 'ABCDE23456');

    await expect(
      matcher.compare(await matcher.listCandidates(USER_ID), 'ABCDE23456'),
    ).resolves.toBe(id);
  });

  it('returns null for a code that matches no row, without marking anything used', async () => {
    const codes = new FakeRecoveryCodes();
    const hasher = new FakePasswordHasher();
    const matcher = new RecoveryCodeMatcher(codes, hasher);

    const id = seedCode(codes, 'ABCDE23456');

    await expect(
      matcher.compare(await matcher.listCandidates(USER_ID), 'ZZZZZ99999'),
    ).resolves.toBeNull();
    expect(codes.rows.get(id)?.usedAt).toBeNull();
  });

  it('does not consider an already-used row a match', async () => {
    const codes = new FakeRecoveryCodes();
    const hasher = new FakePasswordHasher();
    const matcher = new RecoveryCodeMatcher(codes, hasher);

    const id = seedCode(codes, 'ABCDE23456');

    await codes.markUsed(USER_ID, id, new Date());

    await expect(
      matcher.compare(await matcher.listCandidates(USER_ID), 'ABCDE23456'),
    ).resolves.toBeNull();
  });

  it('runs exactly ten verifications whether one code remains or ten do — the L-2 timing regression', async () => {
    const fullCodes = new FakeRecoveryCodes();
    const fullHasher = new FakePasswordHasher();
    const fullMatcher = new RecoveryCodeMatcher(fullCodes, fullHasher);

    for (let index = 0; index < 10; index += 1) seedCode(fullCodes, `FULLBATCH${index.toString()}`);
    await fullMatcher.compare(await fullMatcher.listCandidates(USER_ID), 'ZZZZZ99999');

    const emptyCodes = new FakeRecoveryCodes();
    const emptyHasher = new FakePasswordHasher();
    const emptyMatcher = new RecoveryCodeMatcher(emptyCodes, emptyHasher);

    seedCode(emptyCodes, 'ABCDE23456');
    await emptyMatcher.compare(await emptyMatcher.listCandidates(USER_ID), 'ZZZZZ99999');

    expect(fullHasher.verified.length).toBe(10);
    expect(emptyHasher.verified.length).toBe(10);
  });

  it('pads with the dummy hash when fewer than ten rows remain', async () => {
    const codes = new FakeRecoveryCodes();
    const hasher = new FakePasswordHasher();
    const matcher = new RecoveryCodeMatcher(codes, hasher);

    seedCode(codes, 'ABCDE23456');
    await matcher.compare(await matcher.listCandidates(USER_ID), 'ZZZZZ99999');

    const dummyVerifications = hasher.verified.filter((call) => call.digest === hasher.dummyHash);

    expect(dummyVerifications.length).toBe(9);
  });
});
