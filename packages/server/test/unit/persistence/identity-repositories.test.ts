import { describe, expect, it } from 'vitest';

import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import { PrismaAuthLookup } from '@/infrastructure/persistence/prisma/auth-lookup.adapter.js';
import {
  detachedAuthLookup,
  detachedUnitOfWork,
} from '@/infrastructure/persistence/prisma/detached-database.adapter.js';
import { PrismaOwnerRoleSeeder } from '@/infrastructure/persistence/prisma/owner-role-seeder.adapter.js';
import { PrismaSessionRepository } from '@/infrastructure/persistence/prisma/session.repository.js';
import { withTenant, type TxClient } from '@/infrastructure/persistence/prisma/tenant.context.js';
import { PrismaUserRepository } from '@/infrastructure/persistence/prisma/user.repository.js';

/**
 * The identity repositories with the driver replaced by a recorder.
 *
 * What is asserted here is the *statement* — which columns are written, which predicate an update
 * carries, which value a raw query binds — because that is the half a live database cannot show. A
 * `UPDATE … WHERE revoked_at IS NULL` and a `UPDATE …` without the predicate both succeed against
 * PostgreSQL; only the second one lets two requests rotate the same token, and only a test that
 * reads the statement can tell them apart. That the policy then agrees is the subject of
 * `test/integration/db/**`, which runs the same code against a real server.
 */

const ORG = '018f4a3b-0000-7000-8000-000000000001';
const USER = '018f4a3b-0000-7000-8000-0000000000bb';
const SESSION = '018f4a3b-0000-7000-8000-0000000000cc';

interface Recorder {
  /** Every raw statement, with the whitespace collapsed so a match reads like the SQL does. */
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

    // `withTenant` opens every scope with two `set_config` statements of its own. They are the
    // subject of `tenant-context.test.ts`, not of this file, and counting them here would make
    // every index below an off-by-two.
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
      create: (args: unknown): Promise<{ id: string }> => {
        calls.push({ method: 'user.create', args });

        return Promise.resolve({ id: USER });
      },
      findFirst: (args: unknown): Promise<unknown> => {
        calls.push({ method: 'user.findFirst', args });

        return Promise.resolve(rows[0] ?? null);
      },
      updateMany: (args: unknown): Promise<{ count: number }> => {
        calls.push({ method: 'user.updateMany', args });

        return Promise.resolve({ count: affected });
      },
    },
    session: {
      findUnique: (args: unknown): Promise<unknown> => {
        calls.push({ method: 'session.findUnique', args });

        return Promise.resolve(rows[0] ?? null);
      },
    },
    organization: {
      updateMany: (args: unknown): Promise<{ count: number }> => {
        calls.push({ method: 'organization.updateMany', args });

        return Promise.resolve({ count: affected });
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

describe('PrismaUserRepository', () => {
  const users = new PrismaUserRepository();

  it('writes the organization of the scope and an explicit ACTIVE status', async () => {
    const client = recordingClient();

    await inScope(client, () =>
      users.createOwner({
        email: 'ada@example.com',
        passwordHash: '$argon2id$digest',
        locale: 'en',
        timezone: 'Europe/Berlin',
      }),
    );

    expect(client.calls[0]).toEqual({
      method: 'user.create',
      args: {
        data: {
          organizationId: ORG,
          email: 'ada@example.com',
          passwordHash: '$argon2id$digest',
          locale: 'en',
          timezone: 'Europe/Berlin',
          status: 'ACTIVE',
        },
        select: { id: true },
      },
    });
  });

  /**
   * The selection is the guard: `passwordHash`, `totpSecretEnc` and the vault verifier columns are
   * absent from it, so nothing downstream can put them in a response or a log by accident.
   */
  it('reads only the columns a session response and the guard need', async () => {
    const client = recordingClient([
      {
        id: USER,
        email: 'ada@example.com',
        locale: 'en',
        timezone: 'UTC',
        status: 'ACTIVE',
        permissionsVersion: 1,
      },
    ]);

    const found = await inScope(client, () => users.findById(USER));

    expect(client.calls[0]?.args).toEqual({
      where: { id: USER, deletedAt: null },
      select: {
        id: true,
        email: true,
        locale: true,
        timezone: true,
        status: true,
        permissionsVersion: true,
      },
    });
    expect(found?.email).toBe('ada@example.com');
  });

  it('answers nothing for an account this organization does not have', async () => {
    const client = recordingClient([]);

    await expect(inScope(client, () => users.findById(USER))).resolves.toBeNull();
  });

  /**
   * `updateMany`, so a row that moved between the sign-in and the re-hash leaves the digest as it
   * was instead of turning a successful sign-in into `user_not_found` through the base class's
   * `P2025` translation.
   */
  it('re-hashes with updateMany, which cannot raise a not-found', async () => {
    const client = recordingClient();

    await inScope(client, () => users.updatePasswordHash(USER, '$argon2id$stronger'));

    expect(client.calls[0]).toEqual({
      method: 'user.updateMany',
      args: {
        where: { id: USER, deletedAt: null },
        data: { passwordHash: '$argon2id$stronger' },
      },
    });
  });
});

describe('PrismaSessionRepository', () => {
  const sessions = new PrismaSessionRepository();

  const draft = {
    userId: USER,
    familyId: '018f4a3b-0000-7000-8000-0000000000dd',
    rotatedFromId: null,
    refreshTokenHash: new Uint8Array(32),
    userAgent: 'Firefox/128.0',
    ipHash: 'hmac',
    ipMasked: '203.0.113.0/24',
    expiresAt: new Date('2026-08-28T10:00:00.000Z'),
  };

  it('inserts with the organization of the scope and tolerates a taken digest', async () => {
    const client = recordingClient([]);

    const created = await inScope(client, () => sessions.create(draft));

    expect(created).toBeNull();
    expect(client.statements[0]).toContain('ON CONFLICT (refresh_token_hash) DO NOTHING');
    expect(client.bindings[0]?.[0]).toBe(ORG);
  });

  it('returns the row it wrote when the digest was free', async () => {
    const client = recordingClient([{ id: SESSION, created_at: new Date(0) }]);

    await expect(inScope(client, () => sessions.create(draft))).resolves.toEqual({
      id: SESSION,
      createdAt: new Date(0),
    });
  });

  /**
   * The statement the whole race depends on. Without `AND revoked_at IS NULL` two requests holding
   * the same token both update a row and both mint a session, and reuse detection then reports a
   * theft that never happened.
   */
  it('rotates with a conditional update and reports whether it won', async () => {
    const client = recordingClient([], 1);

    await expect(inScope(client, () => sessions.markRotated(SESSION, new Date(0)))).resolves.toBe(
      true,
    );
    expect(client.statements[0]).toContain('UPDATE sessions');
    expect(client.statements[0]).toContain('AND revoked_at IS NULL');
    expect(client.statements[0]).toContain("revoked_reason = 'ROTATED'::session_revoked_reason");
  });

  it('reports the loss when the row was already spent', async () => {
    const client = recordingClient([], 0);

    await expect(inScope(client, () => sessions.markRotated(SESSION, new Date(0)))).resolves.toBe(
      false,
    );
  });

  it('revokes one row conditionally', async () => {
    const client = recordingClient([], 1);

    await expect(
      inScope(client, () => sessions.revoke(SESSION, 'LOGOUT', new Date(0))),
    ).resolves.toBe(true);
    expect(client.statements[0]).toContain('WHERE id =');
    expect(client.statements[0]).toContain('AND revoked_at IS NULL');
  });

  it('reports false when the row was already revoked', async () => {
    const client = recordingClient([], 0);

    await expect(
      inScope(client, () => sessions.revoke(SESSION, 'LOGOUT', new Date(0))),
    ).resolves.toBe(false);
  });

  /** One indexed update over the family, never a walk of the rotation chain. */
  it('revokes a family in a single statement over family_id', async () => {
    const client = recordingClient([], 3);

    await expect(
      inScope(client, () => sessions.revokeFamily('f0f0', 'REUSE_DETECTED', new Date(0))),
    ).resolves.toBe(3);
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]).toContain('WHERE family_id =');
  });

  it('counts families rather than rows when closing the others', async () => {
    const client = recordingClient([{ count: 2 }]);

    await expect(
      inScope(client, () =>
        sessions.revokeOtherFamilies(USER, 'keep', 'REVOKED_BY_USER', new Date(0)),
      ),
    ).resolves.toBe(2);
    expect(client.statements[0]).toContain('count(DISTINCT family_id)');
    expect(client.statements[0]).toContain('family_id <>');
  });

  it('answers zero when the update returned nothing', async () => {
    const client = recordingClient([]);

    await expect(
      inScope(client, () =>
        sessions.revokeOtherFamilies(USER, 'keep', 'REVOKED_BY_USER', new Date(0)),
      ),
    ).resolves.toBe(0);
  });

  it('reads the owner of a row through the model, revoked or not', async () => {
    const client = recordingClient([{ id: SESSION, userId: USER, familyId: 'f0f0' }]);

    await expect(inScope(client, () => sessions.findOwner(SESSION))).resolves.toEqual({
      id: SESSION,
      userId: USER,
      familyId: 'f0f0',
    });
    expect(client.calls[0]?.args).toEqual({
      where: { id: SESSION },
      select: { id: true, userId: true, familyId: true },
    });
  });

  it('joins the account in one read so the guard costs one round trip', async () => {
    const client = recordingClient([
      {
        session_id: SESSION,
        user_id: USER,
        family_id: 'f0f0',
        revoked_at: null,
        expires_at: new Date(0),
        user_status: 'ACTIVE',
        permissions_version: 4,
      },
    ]);

    const context = await inScope(client, () => sessions.findAuthContext(SESSION));

    expect(context).toEqual({
      sessionId: SESSION,
      userId: USER,
      familyId: 'f0f0',
      revokedAt: null,
      expiresAt: new Date(0),
      userStatus: 'ACTIVE',
      permissionsVersion: 4,
    });
    expect(client.statements[0]).toContain('JOIN users u');
    expect(client.statements).toHaveLength(1);
  });

  it('answers nothing when the session is not this organization’s', async () => {
    const client = recordingClient([]);

    await expect(inScope(client, () => sessions.findAuthContext(SESSION))).resolves.toBeNull();
  });

  it('dates a live session from its family and its activity from its own row', async () => {
    const client = recordingClient([
      {
        id: SESSION,
        family_id: 'f0f0',
        started_at: new Date('2026-07-01T00:00:00.000Z'),
        last_used_at: new Date('2026-07-29T00:00:00.000Z'),
        expires_at: new Date('2026-08-28T00:00:00.000Z'),
        user_agent: 'Firefox/128.0',
        ip_masked: '203.0.113.0/24',
      },
    ]);

    const active = await inScope(client, () => sessions.listActive(USER, new Date(0)));

    expect(active).toEqual([
      {
        id: SESSION,
        familyId: 'f0f0',
        startedAt: new Date('2026-07-01T00:00:00.000Z'),
        lastUsedAt: new Date('2026-07-29T00:00:00.000Z'),
        expiresAt: new Date('2026-08-28T00:00:00.000Z'),
        userAgent: 'Firefox/128.0',
        ipMasked: '203.0.113.0/24',
      },
    ]);
    expect(client.statements[0]).toContain('min(');
    expect(client.statements[0]).toContain('revoked_at IS NULL');
  });

  /**
   * Sessions are never deleted — a rotation writes a row and revokes the previous one, so a
   * fifteen-minute access token leaves roughly ninety-six rows per device per day and there is no
   * cleanup job yet (STORY-006-04, «Что осталось»). The list therefore has to be written so that its
   * cost follows the number of *live* devices rather than the number of rows a person has ever had.
   *
   * The version this replaces grouped `min(created_at)` over every row of the user, revoked ones
   * included, and joined the result back: a month-old account with three devices aggregated several
   * thousand rows to return three. The family start still comes from a revoked row — the oldest row
   * of a live family is the original sign-in, which a rotation revoked — so the fix is to compute it
   * per returned row instead of for every family the user has ever had.
   */
  it('computes each family’s start per live row, not over the user’s whole history', async () => {
    const client = recordingClient([]);

    await inScope(client, () => sessions.listActive(USER, new Date(0)));

    const sql = client.statements[0] ?? '';

    expect(sql).toContain('f.family_id = s.family_id');
    expect(sql).not.toMatch(/GROUP BY family_id/);
  });
});

describe('PrismaOwnerRoleSeeder', () => {
  it('records the owner on the organization of the scope, without naming its id twice', async () => {
    const client = recordingClient();

    await inScope(client, () => new PrismaOwnerRoleSeeder().seedSystemRoles(USER));

    expect(client.calls[0]).toEqual({
      method: 'organization.updateMany',
      args: { where: { deletedAt: null }, data: { ownerId: USER } },
    });
  });
});

describe('PrismaAuthLookup', () => {
  const client = (rows: unknown[]): { adapter: PrismaAuthLookup; statements: string[] } => {
    const statements: string[] = [];
    const prisma = {
      $queryRaw: (template: TemplateStringsArray): Promise<unknown[]> => {
        statements.push([...template].join(' ? ').replace(/\s+/g, ' ').trim());

        return Promise.resolve(rows);
      },
    };

    return {
      adapter: new PrismaAuthLookup(prisma as never),
      statements,
    };
  };

  const userRow = {
    user_id: USER,
    email: 'ada@example.com',
    locale: 'en',
    timezone: 'UTC',
    organization_id: ORG,
    organization_name: 'Bad Company',
    organization_slug: 'bad-company',
    password_hash: '$argon2id$digest',
    status: 'ACTIVE',
    permissions_version: 1,
  };

  /**
   * Every call is to a named function with a fixed signature — never a query this adapter composes.
   * That is what keeps the `app_auth` surface to three questions rather than to whatever a caller
   * writes (`docs/security/rls-design.md`, «Особые пути»).
   */
  it('asks a named function for the accounts of an address', async () => {
    const { adapter, statements } = client([userRow]);

    const found = await adapter.findUsersByEmail('ada@example.com');

    expect(statements[0]).toContain('auth_lookup_users_by_email(');
    expect(found).toEqual([
      {
        userId: USER,
        email: 'ada@example.com',
        locale: 'en',
        timezone: 'UTC',
        organizationId: ORG,
        organizationName: 'Bad Company',
        organizationSlug: 'bad-company',
        passwordHash: '$argon2id$digest',
        status: 'ACTIVE',
        permissionsVersion: 1,
      },
    ]);
  });

  it('asks the pair function when the organization is named', async () => {
    const { adapter, statements } = client([userRow]);

    await expect(
      adapter.findUserByEmailAndSlug('ada@example.com', 'bad-company'),
    ).resolves.toMatchObject({ userId: USER });
    expect(statements[0]).toContain('auth_lookup_user(');
  });

  it('answers nothing for an address and slug that do not pair up', async () => {
    const { adapter } = client([]);

    await expect(
      adapter.findUserByEmailAndSlug('ada@example.com', 'no-such-company'),
    ).resolves.toBeNull();
  });

  it('resolves a session by the digest of its token', async () => {
    const { adapter, statements } = client([
      {
        session_id: SESSION,
        user_id: USER,
        organization_id: ORG,
        family_id: 'f0f0',
        revoked_at: null,
        revoked_reason: null,
        expires_at: new Date(0),
      },
    ]);

    await expect(adapter.findSessionByRefreshHash(new Uint8Array(32))).resolves.toEqual({
      sessionId: SESSION,
      userId: USER,
      organizationId: ORG,
      familyId: 'f0f0',
      revokedAt: null,
      revokedReason: null,
      expiresAt: new Date(0),
    });
    expect(statements[0]).toContain('auth_lookup_session(');
  });

  it('answers nothing for a digest no row carries', async () => {
    const { adapter } = client([]);

    await expect(adapter.findSessionByRefreshHash(new Uint8Array(32))).resolves.toBeNull();
  });
});

/**
 * The ports of a container built without a database.
 *
 * They exist so that the HTTP and contract suites can build the real application with no connection
 * behind it, and every one of them throws rather than behaving like an empty database — a container
 * that reached one of these in production is misconfigured, and pretending otherwise would answer
 * "no such user" to every sign-in.
 */
describe('a container built without a database', () => {
  it('refuses to open a tenant scope, naming the missing configuration', () => {
    expect(() =>
      detachedUnitOfWork().withTenant({ organizationId: ORG, userId: null }, () =>
        Promise.resolve(1),
      ),
    ).toThrow(/DATABASE_URL/);
  });

  /**
   * The refusal itself; that it carries the `service_unavailable` code and names the variable in
   * `details` rather than in `message` is asserted in
   * `test/unit/bootstrap/auth-availability.test.ts`, next to the rest of the missing-pool
   * behaviour.
   */
  it.each([
    ['findUsersByEmail', () => detachedAuthLookup().findUsersByEmail('ada@example.com')],
    ['findUserByEmailAndSlug', () => detachedAuthLookup().findUserByEmailAndSlug('a', 'b')],
    [
      'findSessionByRefreshHash',
      () => detachedAuthLookup().findSessionByRefreshHash(new Uint8Array(1)),
    ],
  ])('refuses %s rather than answering as an empty database', (_case, run) => {
    expect(run).toThrow(ServiceUnavailableError);
  });
});
