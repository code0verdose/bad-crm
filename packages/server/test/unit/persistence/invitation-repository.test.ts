import { describe, expect, it } from 'vitest';

import { PrismaInvitationRepository } from '@/infrastructure/persistence/prisma/invitation.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Invitations through Prisma, with the driver replaced by a recorder.
 *
 * What is asserted here is the shape of the statements, which is where this repository's decisions
 * live and where a live database would agree with a wrong one just as happily:
 *
 *   * **no read selects `token_hash`.** A row this repository hands out cannot leak a credential
 *     into a log, a serializer or a snapshot, because it does not carry one;
 *   * **the conditional writes are one statement each**, not «read, then write» — somebody who
 *     accepted in the meantime must not be handed a new link, and a check made one statement earlier
 *     is a check something can happen after. What the predicate *says* is asserted where it can be
 *     run, against a real PostgreSQL: `test/integration/db/invitation-join-teams.test.ts`. Asserting
 *     substrings of the SQL here would be the trap that hid a blocker in this very file — a recorded
 *     driver cannot tell a valid statement from one PostgreSQL refuses to parse;
 *   * **the tenant leads every filter**, taken from the scope rather than from an argument;
 *   * the digest is written as **bytes**, like every other digest in this schema.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000d1';
const INVITATION = '018f4a3b-0000-7000-8000-0000000000d2';

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  /** The SQL of every raw statement, so a predicate can be asserted rather than assumed. */
  readonly raw: string[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (
  state: {
    rows?: unknown[];
    row?: unknown;
    user?: unknown;
    role?: unknown;
    /** How many rows the conditional writes match; `0` is «somebody got there first». */
    touched?: number;
    /** What the raw `UPDATE … RETURNING` answers with. */
    raw?: unknown[];
    /** What `$executeRaw` reports as affected rows. */
    affected?: number;
    createdUser?: { id: string };
  } = {},
): Recorder => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const raw: string[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const tx = {
    // `withTenant` opens the scope with two `set_config` statements before any model call. The
    // template strings of the repository's own raw writes are recorded so their predicates can be
    // asserted — a conditional write is exactly the kind of thing that keeps working after the
    // condition is dropped.
    $executeRaw: (parts: TemplateStringsArray): Promise<number> => {
      // `withTenant` opens every scope with two `set_config` statements of its own; recording them
      // would make «this method sent nothing» impossible to assert.
      const sql = parts.join(' ? ');

      if (!sql.includes('set_config')) raw.push(sql);

      return Promise.resolve(state.affected ?? 1);
    },
    $queryRaw: (parts: TemplateStringsArray): Promise<unknown[]> => {
      raw.push(parts.join(' ? '));

      return Promise.resolve(state.raw ?? []);
    },
    invitation: {
      create: record('create', { id: INVITATION }),
      findFirst: record('findFirst', state.row ?? null),
      findMany: record('findMany', state.rows ?? []),
      updateMany: record('updateMany', { count: state.touched ?? 1 }),
      deleteMany: record('deleteMany', { count: state.touched ?? 1 }),
    },
    user: {
      findFirst: record('user.findFirst', state.user ?? null),
      create: record('user.create', state.createdUser ?? { id: 'user-1' }),
    },
    role: { findFirst: record('role.findFirst', state.role ?? null) },
  };

  return {
    calls,
    raw,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inScope = async <T>(
  recorder: Recorder,
  work: (repository: PrismaInvitationRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaInvitationRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

const storedRow = {
  id: INVITATION,
  email: 'ivan@example.test',
  roleId: null,
  teamIds: [],
  locale: 'ru',
  invitedById: 'admin',
  expiresAt: new Date('2026-08-14T10:00:00.000Z'),
  acceptedAt: null,
  createdAt: new Date('2026-08-07T10:00:00.000Z'),
};

describe('storing an invitation', () => {
  it('writes the digest as bytes, in the organization of the scope', async () => {
    const recorder = recordingClient();
    const digest = new Uint8Array(32).fill(7);

    const id = await inScope(recorder, (repository) =>
      repository.create({
        email: 'ivan@example.test',
        roleId: null,
        teamIds: ['team-1', 'team-1'],
        tokenHash: digest,
        locale: 'en',
        invitedById: 'admin',
        expiresAt: new Date('2026-08-14T10:00:00.000Z'),
      }),
    );

    expect(id).toBe(INVITATION);

    const data = (argsOf(recorder, 'create') as { data: Record<string, unknown> }).data;

    expect(data['organizationId']).toBe(ORG);
    // Bytes, not hex: `sessions.refresh_token_hash` and `password_reset_tokens.token_hash` are
    // `BYTEA`, and a digest stored as text in one table and bytes in another is two conventions.
    expect(Buffer.isBuffer(data['tokenHash'])).toBe(true);
    expect(data['tokenHash']).toEqual(Buffer.from(digest));
    expect(data['locale']).toBe('en');
    // Only the id comes back: nothing that could carry the digest into a caller.
    expect(argsOf(recorder, 'create')['select']).toEqual({ id: true });
  });
});

describe('reading invitations', () => {
  it('never selects the digest', async () => {
    const recorder = recordingClient({ row: storedRow, rows: [storedRow] });

    await inScope(recorder, (repository) => repository.byId(INVITATION));
    await inScope(recorder, (repository) => repository.listOpen());

    for (const name of ['findFirst', 'findMany']) {
      const select = argsOf(recorder, name)['select'] as Record<string, unknown>;

      expect(select['tokenHash']).toBeUndefined();
      expect(select['email']).toBe(true);
    }
  });

  it('narrows the stored language, so a value past the constraint is a letter and not a crash', async () => {
    const recorder = recordingClient({ row: { ...storedRow, locale: 'de-DE' } });

    const invitation = await inScope(recorder, (repository) => repository.byId(INVITATION));

    expect(invitation?.locale).toBe('en');
  });

  it('answers null for an invitation of another organization', async () => {
    const recorder = recordingClient();

    expect(await inScope(recorder, (repository) => repository.byId(INVITATION))).toBeNull();
    expect(argsOf(recorder, 'findFirst')['where']).toEqual({ organizationId: ORG, id: INVITATION });
  });

  it('lists only the open ones, newest first', async () => {
    const recorder = recordingClient({ rows: [storedRow] });

    const rows = await inScope(recorder, (repository) => repository.listOpen());

    expect(rows).toHaveLength(1);
    expect(argsOf(recorder, 'findMany')['where']).toEqual({
      organizationId: ORG,
      acceptedAt: null,
    });
    expect(argsOf(recorder, 'findMany')['orderBy']).toEqual({ createdAt: 'desc' });
  });
});

describe('re-issuing and removing', () => {
  it('replaces the digest only while the invitation is still open', async () => {
    const recorder = recordingClient();
    const digest = new Uint8Array(32).fill(9);

    const touched = await inScope(recorder, (repository) =>
      repository.reissue(INVITATION, digest, new Date('2026-08-21T10:00:00.000Z')),
    );

    expect(touched).toBe(true);
    expect(argsOf(recorder, 'updateMany')['where']).toEqual({
      organizationId: ORG,
      id: INVITATION,
      acceptedAt: null,
    });
    expect(
      (argsOf(recorder, 'updateMany') as { data: { tokenHash: unknown } }).data.tokenHash,
    ).toEqual(Buffer.from(digest));
  });

  it('deletes with the same predicate, and reports a miss rather than pretending', async () => {
    const recorder = recordingClient({ touched: 0 });

    expect(await inScope(recorder, (repository) => repository.remove(INVITATION))).toBe(false);
    expect(argsOf(recorder, 'deleteMany')['where']).toEqual({
      organizationId: ORG,
      id: INVITATION,
      acceptedAt: null,
    });
  });

  it('reports a miss on re-issue too', async () => {
    const recorder = recordingClient({ touched: 0 });

    expect(
      await inScope(recorder, (repository) =>
        repository.reissue(INVITATION, new Uint8Array(32), new Date()),
      ),
    ).toBe(false);
  });
});

describe('spending an invitation and what it produces', () => {
  it('spends it with `accepted_at IS NULL` and the expiry in one predicate', async () => {
    // Raw, because `updateMany` cannot return the row: `RETURNING` is what makes «spend it and tell
    // me what it said» one statement, and one statement is what makes two clicks race properly.
    const recorder = recordingClient({
      raw: [{ email: 'ivan@example.test', role_id: null, team_ids: [] }],
    });

    const spent = await inScope(recorder, (repository) =>
      repository.accept(INVITATION, 'user-1', new Date('2026-08-10T10:00:00.000Z')),
    );

    expect(spent).toEqual({ email: 'ivan@example.test', roleId: null, teamIds: [] });
    // One statement, not «read then write»: what makes the acceptance single-use is that the
    // predicate and the write are the same operation.
    expect(recorder.raw).toHaveLength(1);
  });

  it('answers null when the write matched nothing', async () => {
    const recorder = recordingClient({ raw: [] });

    expect(
      await inScope(recorder, (repository) => repository.accept(INVITATION, 'user-1', new Date())),
    ).toBeNull();
  });

  it('creates the account ACTIVE, in the organization of the scope', async () => {
    const recorder = recordingClient({ createdUser: { id: 'user-1' } });

    const userId = await inScope(recorder, (repository) =>
      repository.createAccount({
        email: 'ivan@example.test',
        passwordHash: '$argon2id$x',
        locale: 'ru',
        timezone: 'Europe/Moscow',
      }),
    );

    expect(userId).toBe('user-1');

    const data = (argsOf(recorder, 'user.create') as { data: Record<string, unknown> }).data;

    // `ACTIVE`, not `INVITED`: by now the person holds the link and has chosen a password.
    expect(data['status']).toBe('ACTIVE');
    expect(data['organizationId']).toBe(ORG);
  });

  /**
   * The one thing about `joinTeams` a recorded driver can honestly answer: whether a statement was
   * sent at all.
   *
   * What it **cannot** answer is whether the statement is valid, and this test used to pretend
   * otherwise — it asserted that the SQL string contained `FROM teams`, `deleted_at IS NULL` and
   * `ON CONFLICT`. All three passed against a statement PostgreSQL refuses to parse
   * (`ON CONFLICT ON CONSTRAINT` naming a unique *index*), so every acceptance carrying a team
   * failed in production while this file stayed green. Those assertions are gone; the behaviour
   * they were reaching for is asserted against a real database in
   * `test/integration/db/invitation-join-teams.test.ts`, with a positive control.
   */
  it('sends nothing at all when the invitation named no team', async () => {
    const recorder = recordingClient({ affected: 1 });

    expect(await inScope(recorder, (repository) => repository.joinTeams('user-1', []))).toBe(0);
    // `team_ids` is a draft, and an empty one is not a write: the short circuit is here, in front of
    // a statement that would otherwise cost a round trip to insert zero rows.
    expect(recorder.raw).toEqual([]);
  });

  it('sends one statement when it does name a team, and reports what it wrote', async () => {
    const recorder = recordingClient({ affected: 1 });

    expect(
      await inScope(recorder, (repository) => repository.joinTeams('user-1', ['team-1'])),
    ).toBe(1);
    // One statement for any number of teams — `INSERT … SELECT`, not a loop. What the statement
    // *says* is asserted where it can be run: `test/integration/db/invitation-join-teams.test.ts`.
    expect(recorder.raw).toHaveLength(1);
  });
});

describe('what the address and the role are checked against', () => {
  it('ignores a deleted account when deciding whether the address is taken', async () => {
    // `uq_users_org_email` is partial on `deleted_at IS NULL`: inviting somebody who was deleted is
    // allowed, and inviting somebody merely suspended is not.
    const recorder = recordingClient({ user: { id: 'ivan' } });

    expect(
      await inScope(recorder, (repository) => repository.userExists('ivan@example.test')),
    ).toBe(true);
    expect(argsOf(recorder, 'user.findFirst')['where']).toEqual({
      organizationId: ORG,
      email: 'ivan@example.test',
      deletedAt: null,
    });
  });

  it('answers false when nobody holds the address', async () => {
    const recorder = recordingClient();

    expect(
      await inScope(recorder, (repository) => repository.userExists('nobody@example.test')),
    ).toBe(false);
  });

  it('returns what a role grants, dropping retired keys and anything not in the catalogue', async () => {
    const recorder = recordingClient({
      role: {
        permissions: [
          { permissionKey: 'task:read' },
          // A key the catalogue no longer knows grants nothing, so it is not something the
          // invitation hands out either.
          { permissionKey: 'ancient:power' },
        ],
      },
    });

    expect(await inScope(recorder, (repository) => repository.rolePermissions('role-1'))).toEqual([
      'task:read',
    ]);

    const select = argsOf(recorder, 'role.findFirst')['select'] as {
      permissions: { where: unknown };
    };

    expect(select.permissions.where).toEqual({ permission: { deprecatedAt: null } });
  });

  it('answers null for a role of another organization, so the caller can say 404', async () => {
    const recorder = recordingClient();

    expect(
      await inScope(recorder, (repository) => repository.rolePermissions('role-1')),
    ).toBeNull();
  });
});
