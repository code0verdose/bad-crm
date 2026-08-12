import { describe, expect, it } from 'vitest';

import { PrismaMfaRecoveryCodeRepository } from '@/infrastructure/persistence/prisma/mfa-recovery-code.repository.js';
import { PrismaTotpEnrollmentRepository } from '@/infrastructure/persistence/prisma/totp-enrollment.repository.js';
import { withTenant, type TxClient } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * `PrismaTotpEnrollmentRepository` and `PrismaMfaRecoveryCodeRepository`, with the driver replaced
 * by a recorder — the same technique `identity-repositories.test.ts` uses for the rest of the
 * identity module, and for the identical reason: what is asserted here is the *statement*, which a
 * live database cannot show apart from its correctly-guarded twin. `UPDATE users SET
 * totp_enabled_at = … WHERE totp_enabled_at IS NULL` and the same statement without the predicate
 * both succeed against PostgreSQL; only a test that reads the SQL can tell them apart. That the
 * guarded version actually stops a race is the subject of
 * `test/integration/db/mfa-recovery-code-race.test.ts`, against a real server.
 */

const ORG = '018f4a3b-0000-7000-8000-000000000001';
const USER = '018f4a3b-0000-7000-8000-0000000000bb';
const CODE_ID = '018f4a3b-0000-7000-8000-0000000000ee';

interface Recorder {
  readonly statements: string[];
  readonly bindings: unknown[][];
  readonly calls: { method: string; args: unknown }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (rows: unknown[] = [], affected = 1): Recorder => {
  const statements: string[] = [];
  const bindings: unknown[][] = [];
  const calls: { method: string; args: unknown }[] = [];

  const record = (template: TemplateStringsArray | string[], values: unknown[]): void => {
    const sql = [...template].join(' ? ').replace(/\s+/g, ' ').trim();

    if (sql.startsWith('SELECT set_config(')) return;

    statements.push(sql);
    bindings.push(values);
  };

  const tx = {
    $executeRaw: (template: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      record(template, values);

      return Promise.resolve(affected);
    },
    $queryRaw: (template: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      record(template, values);

      return Promise.resolve(rows);
    },
    user: {
      findFirst: (args: unknown): Promise<unknown> => {
        calls.push({ method: 'user.findFirst', args });

        return Promise.resolve(rows[0] ?? null);
      },
    },
    mfaRecoveryCode: {
      createMany: (args: unknown): Promise<{ count: number }> => {
        calls.push({ method: 'mfaRecoveryCode.createMany', args });

        return Promise.resolve({ count: affected });
      },
      findMany: (args: unknown): Promise<unknown[]> => {
        calls.push({ method: 'mfaRecoveryCode.findMany', args });

        return Promise.resolve(rows);
      },
      deleteMany: (args: unknown): Promise<{ count: number }> => {
        calls.push({ method: 'mfaRecoveryCode.deleteMany', args });

        return Promise.resolve({ count: affected });
      },
      count: (args: unknown): Promise<number> => {
        calls.push({ method: 'mfaRecoveryCode.count', args });

        return Promise.resolve(affected);
      },
    },
  } as unknown as TxClient;

  return {
    statements,
    bindings,
    calls,
    base: {
      $transaction: async (run: (handle: TxClient) => Promise<unknown>): Promise<unknown> =>
        run(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inScope = <T>(client: Recorder, work: () => Promise<T>): Promise<T> =>
  withTenant(client.base, { organizationId: ORG, userId: USER }, work);

describe('PrismaTotpEnrollmentRepository', () => {
  const enrollment = new PrismaTotpEnrollmentRepository();
  const NOW = new Date('2026-07-29T10:00:00.000Z');

  it('reads the four TOTP columns and nothing else', async () => {
    const client = recordingClient([
      {
        totpSecretEnc: 'v1:enc',
        totpEnabledAt: null,
        totpDraftExpiresAt: NOW,
        totpLastCounter: null,
      },
    ]);

    const state = await inScope(client, () => enrollment.find(USER));

    expect(client.calls[0]).toEqual({
      method: 'user.findFirst',
      args: {
        where: { id: USER, deletedAt: null },
        select: {
          totpSecretEnc: true,
          totpEnabledAt: true,
          totpDraftExpiresAt: true,
          totpLastCounter: true,
        },
      },
    });
    expect(state).toEqual({
      secretEnc: 'v1:enc',
      enabledAt: null,
      draftExpiresAt: NOW,
      lastCounter: null,
    });
  });

  it('answers null when there is no secret at all — draft or enabled', async () => {
    const client = recordingClient([
      { totpSecretEnc: null, totpEnabledAt: null, totpDraftExpiresAt: null, totpLastCounter: null },
    ]);

    await expect(inScope(client, () => enrollment.find(USER))).resolves.toBeNull();
  });

  it('answers null when the account row itself cannot be found', async () => {
    const client = recordingClient([]);

    await expect(inScope(client, () => enrollment.find(USER))).resolves.toBeNull();
  });

  it('drafts with a single statement guarded by totp_enabled_at IS NULL', async () => {
    const client = recordingClient([{ id: USER }]);

    const written = await inScope(client, () => enrollment.beginDraft(USER, 'v1:enc', NOW));

    expect(written).toBe(true);
    const sql = client.statements[0] ?? '';

    expect(sql).toContain('UPDATE users');
    expect(sql).toContain('totp_enabled_at IS NULL');
    expect(sql).toContain('totp_last_counter = NULL');
  });

  it('reports false when the account already has 2FA enabled', async () => {
    const client = recordingClient([]);

    await expect(inScope(client, () => enrollment.beginDraft(USER, 'v1:enc', NOW))).resolves.toBe(
      false,
    );
  });

  it('commits with a statement carrying both the enrolment and the expiry predicate', async () => {
    const client = recordingClient([{ id: USER }]);

    const committed = await inScope(client, () => enrollment.commitEnrollment(USER, 42, NOW));

    expect(committed).toBe(true);
    const sql = client.statements[0] ?? '';

    expect(sql).toContain('totp_enabled_at IS NULL');
    expect(sql).toContain('totp_draft_expires_at >');
    expect(sql).toContain('totp_last_counter =');
  });

  it('reports false for an expired or already-confirmed draft', async () => {
    const client = recordingClient([]);

    await expect(inScope(client, () => enrollment.commitEnrollment(USER, 42, NOW))).resolves.toBe(
      false,
    );
  });

  it('advances the counter only forward, guarded in the predicate', async () => {
    const client = recordingClient([{ id: USER }]);

    const advanced = await inScope(client, () => enrollment.advanceCounter(USER, 43));

    expect(advanced).toBe(true);
    const sql = client.statements[0] ?? '';

    expect(sql).toContain('totp_enabled_at IS NOT NULL');
    expect(sql).toContain('totp_last_counter IS NULL OR totp_last_counter <');
  });

  it('reports false for a replayed or earlier counter', async () => {
    const client = recordingClient([]);

    await expect(inScope(client, () => enrollment.advanceCounter(USER, 1))).resolves.toBe(false);
  });

  it('abandons a draft by clearing all three columns, guarded by totp_enabled_at IS NULL', async () => {
    const client = recordingClient();

    await inScope(client, () => enrollment.abandonDraft(USER));

    const sql = client.statements[0] ?? '';

    expect(sql).toContain('totp_secret_enc = NULL');
    expect(sql).toContain('totp_draft_expires_at = NULL');
    expect(sql).toContain('totp_last_counter = NULL');
    expect(sql).toContain('totp_enabled_at IS NULL');
  });
});

describe('PrismaMfaRecoveryCodeRepository', () => {
  const codes = new PrismaMfaRecoveryCodeRepository();
  const NOW = new Date('2026-07-29T10:00:00.000Z');

  it('writes every hash with the organization of the scope', async () => {
    const client = recordingClient();

    await inScope(client, () => codes.createMany(USER, ['hash1', 'hash2']));

    expect(client.calls[0]).toEqual({
      method: 'mfaRecoveryCode.createMany',
      args: {
        data: [
          { organizationId: ORG, userId: USER, codeHash: 'hash1' },
          { organizationId: ORG, userId: USER, codeHash: 'hash2' },
        ],
      },
    });
  });

  /**
   * Three predicates, and the third one is the one no behaviour can show today.
   *
   * `userId` and `usedAt: null` are what the consume loop obviously needs. `user: { deletedAt: null }`
   * is the same filter `PrismaTotpEnrollmentRepository.find` carries, and it is here because nothing
   * else in the product removes this table's rows when an account is switched off:
   * `PENDING_OFFBOARDING_STEPS` names projects, sockets, links and the vault, and says nothing about
   * the second factor. Without the predicate a deleted account's codes stay a usable set — the
   * candidate list is the *only* gate a presented code passes.
   */
  it('lists only the unused rows of an account that has not been deleted', async () => {
    const client = recordingClient([{ id: CODE_ID, codeHash: 'hash1' }]);

    const unused = await inScope(client, () => codes.listUnused(USER));

    expect(client.calls[0]).toEqual({
      method: 'mfaRecoveryCode.findMany',
      args: {
        where: { userId: USER, usedAt: null, user: { deletedAt: null } },
        select: { id: true, codeHash: true },
      },
    });
    expect(unused).toEqual([{ id: CODE_ID, codeHash: 'hash1' }]);
  });

  it('spends one row with a statement guarded by used_at IS NULL and user_id', async () => {
    const client = recordingClient([{ id: CODE_ID }]);

    const won = await inScope(client, () => codes.markUsed(USER, CODE_ID, NOW));

    expect(won).toBe(true);
    const sql = client.statements[0] ?? '';

    expect(sql).toContain('UPDATE mfa_recovery_codes');
    expect(sql).toContain('used_at IS NULL');
    expect(sql).toContain('user_id =');
    expect(sql).toContain('RETURNING id');
  });

  it('reports false for a code that was already spent', async () => {
    const client = recordingClient([]);

    await expect(inScope(client, () => codes.markUsed(USER, CODE_ID, NOW))).resolves.toBe(false);
  });

  it('deletes every row of the account in one statement', async () => {
    const client = recordingClient([], 7);

    const removed = await inScope(client, () => codes.deleteAllForUser(USER));

    expect(removed).toBe(7);
    expect(client.calls[0]).toEqual({
      method: 'mfaRecoveryCode.deleteMany',
      args: { where: { userId: USER } },
    });
  });

  it('counts total and remaining as two independent predicates', async () => {
    const client = recordingClient([], 10);

    const counts = await inScope(client, () => codes.counts(USER));

    expect(counts).toEqual({ total: 10, remaining: 10 });
    expect(client.calls[0]).toEqual({
      method: 'mfaRecoveryCode.count',
      args: { where: { userId: USER } },
    });
    expect(client.calls[1]).toEqual({
      method: 'mfaRecoveryCode.count',
      args: { where: { userId: USER, usedAt: null } },
    });
  });
});
