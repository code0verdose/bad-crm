import { beforeEach, describe, expect, it } from 'vitest';

import {
  type AcceptedInvitation,
  type InvitationRepositoryPort,
  type InvitationRow,
  type InvitedAccountDraft,
} from '@/application/iam/ports/invitation-repository.port.js';
import { AcceptInvitationUseCase } from '@/application/iam/use-cases/accept-invitation.use-case.js';
import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { InvitationNotValidError, RateLimitedError } from '@/domain/shared/errors/app.errors.js';

import {
  FakeClock,
  FakeOrganizations,
  FakeRateLimit,
  FakeResetTokens,
  FakeUnitOfWork,
  RecordingLogger,
} from '../../support/identity-doubles.util.js';

/**
 * Accepting an invitation — the one operation of this product that creates an account without a
 * session, and therefore the one where the token is the whole authorisation.
 *
 * Four properties carry it, and each is an ordering rather than a value:
 *
 *   * **the budget is spent first**, before the digest is computed and before anything is read: the
 *     caller is anonymous, so the address is the only subject there is, and a limiter checked after
 *     an argon2id hash is a memory-exhaustion vector rather than a defence (`T-IAM-08`);
 *   * **unknown, revoked, accepted, expired and «organization deactivated» are one answer.**
 *     Anything else lets somebody with a guessed token learn whether it ever existed (`T-IAM-03`);
 *   * **the account is created on the address of the row**, never on one from the request;
 *   * **the invitation is spent by a conditional write**, so two clicks race and one of them loses.
 */

const ORG = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const INVITATION = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5aa1';
const ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5aa2';
const TEAM = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5aa3';
const USER = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const CLIENT = { userAgent: 'vitest', ipAddress: '203.0.113.7' };

interface FakeState {
  /** The row as it reads inside the transaction; `null` — revoked between the resolver and the read. */
  readonly row?: InvitationRow | null;
  /** `null` — the resolver found nothing: unknown, revoked, or a deactivated organization. */
  readonly resolved?: { invitationId: string; organizationId: string } | null;
  /** `null` — the conditional write matched no row: already accepted, or expired. */
  readonly accepted?: AcceptedInvitation | null;
}

class FakeInvitations implements InvitationRepositoryPort {
  readonly accounts: InvitedAccountDraft[] = [];
  readonly spent: { invitationId: string; userId: string }[] = [];
  readonly joined: { userId: string; teamIds: readonly string[] }[] = [];

  constructor(private readonly state: FakeState = {}) {}

  accept(invitationId: string, acceptedUserId: string): Promise<AcceptedInvitation | null> {
    this.spent.push({ invitationId, userId: acceptedUserId });

    return Promise.resolve(
      'accepted' in this.state
        ? this.state.accepted
        : { email: 'ivan@example.test', roleId: ROLE, teamIds: [TEAM] },
    );
  }

  createAccount(draft: InvitedAccountDraft): Promise<string> {
    this.accounts.push(draft);

    return Promise.resolve(USER);
  }

  joinTeams(userId: string, teamIds: readonly string[]): Promise<readonly string[]> {
    this.joined.push({ userId, teamIds });

    return Promise.resolve(teamIds);
  }

  create(): Promise<string> {
    throw new Error('not part of acceptance');
  }
  /** The read that decides which address the account is created on — not the single-use guard. */
  byId(): Promise<InvitationRow | null> {
    return Promise.resolve(
      'row' in this.state
        ? this.state.row
        : {
            id: INVITATION,
            email: 'ivan@example.test',
            roleId: ROLE,
            teamIds: [TEAM],
            locale: 'ru' as const,
            invitedById: 'admin',
            expiresAt: new Date('2026-08-14T10:00:00.000Z'),
            acceptedAt: null,
            createdAt: new Date('2026-08-07T10:00:00.000Z'),
          },
    );
  }
  reissue(): Promise<boolean> {
    return Promise.resolve(false);
  }
  remove(): Promise<boolean> {
    return Promise.resolve(false);
  }
  listOpen(): Promise<[]> {
    return Promise.resolve([]);
  }
  userExists(): Promise<boolean> {
    return Promise.resolve(false);
  }
  rolePermissions(): Promise<null> {
    return Promise.resolve(null);
  }
}

/** The org-less resolver: a digest in, an organization out — or nothing at all. */
const lookupThatFinds = (state: FakeState) => ({
  findInvitation: () =>
    Promise.resolve(
      'resolved' in state ? state.resolved : { invitationId: INVITATION, organizationId: ORG },
    ),
});

class FakeRoles {
  readonly assigned: { userId: string; roleId: string }[] = [];

  assign(draft: { userId: string; roleId: string }): Promise<{ created: boolean }> {
    this.assigned.push({ userId: draft.userId, roleId: draft.roleId });

    return Promise.resolve({ created: true });
  }
}

class FakeHasher {
  readonly hashed: string[] = [];

  hash(password: string): Promise<string> {
    this.hashed.push(password);

    return Promise.resolve(`$argon2id$${password}`);
  }
}

let unitOfWork: FakeUnitOfWork;
let clock: FakeClock;
let tokens: FakeResetTokens;
let rateLimit: FakeRateLimit;
let hasher: FakeHasher;
let roles: FakeRoles;
let organizations: FakeOrganizations;
let logger: RecordingLogger;
let sessions: { issued: { userId: string }[] };
let audit: { events: AuditEvent[]; port: { record: (event: AuditEvent) => Promise<void> } };

beforeEach(() => {
  unitOfWork = new FakeUnitOfWork();
  clock = new FakeClock(new Date('2026-08-10T10:00:00.000Z'));
  tokens = new FakeResetTokens();
  rateLimit = new FakeRateLimit();
  hasher = new FakeHasher();
  roles = new FakeRoles();
  organizations = new FakeOrganizations();
  logger = new RecordingLogger();
  sessions = { issued: [] };
  const events: AuditEvent[] = [];

  audit = {
    events,
    port: {
      record: (event: AuditEvent): Promise<void> => {
        events.push(event);

        return Promise.resolve();
      },
    },
  };
});

const issueSession = {
  execute: (input: { userId: string }) => {
    sessions.issued.push({ userId: input.userId });

    return Promise.resolve({
      sessionId: 'session-1',
      familyId: 'family-1',
      accessToken: 'access',
      expiresInSeconds: 900,
      refreshToken: 'refresh',
      refreshExpiresAt: new Date('2026-09-09T10:00:00.000Z'),
    });
  },
};

const useCase = (invitations: FakeInvitations, state: FakeState = {}): AcceptInvitationUseCase =>
  new AcceptInvitationUseCase(
    lookupThatFinds(state) as never,
    invitations,
    roles as never,
    organizations,
    issueSession as never,
    hasher as never,
    tokens,
    unitOfWork,
    rateLimit,
    clock,
    logger,
    audit.port,
  );

const accept = (
  invitations: FakeInvitations,
  state: FakeState = {},
  overrides: { token?: string; password?: string } = {},
) =>
  useCase(invitations, state).execute({
    token: overrides.token ?? 'invite-token',
    password: overrides.password ?? 'correct-horse-battery',
    locale: 'ru',
    timezone: 'Europe/Moscow',
    client: CLIENT,
  });

describe('accepting an invitation', () => {
  it('creates the account on the address of the row and issues a session', async () => {
    const invitations = new FakeInvitations();

    const issued = await accept(invitations);

    // The address comes from the invitation, never from the request: the body has no `email` field
    // at all, and this is the assertion that keeps it that way.
    expect(invitations.accounts).toEqual([
      {
        email: 'ivan@example.test',
        passwordHash: '$argon2id$correct-horse-battery',
        locale: 'ru',
        timezone: 'Europe/Moscow',
      },
    ]);
    expect(roles.assigned).toEqual([{ userId: USER, roleId: ROLE }]);
    expect(invitations.joined).toEqual([{ userId: USER, teamIds: [TEAM] }]);
    expect(sessions.issued).toEqual([{ userId: USER }]);
    expect(issued.session.accessToken).toBe('access');
    // The same shape sign-in and registration answer with: the client stores one identity.
    expect(issued.user).toMatchObject({ id: USER, email: 'ivan@example.test', locale: 'ru' });
    expect(issued.organization).toMatchObject({ id: ORG, slug: 'bad-company' });
    // One transaction for the whole thing: the account, the role, the teams and the spend either
    // all happened or none did.
    expect(unitOfWork.scopes).toEqual([{ organizationId: ORG, userId: null }]);
  });

  it('spends the invitation with the id of the account it just created', async () => {
    const invitations = new FakeInvitations();

    await accept(invitations);

    // `ck_invitations_accepted_pair` needs both columns to move together, and the foreign key on
    // `accepted_user_id` is checked when the statement ends — which is why the account is written
    // first and named here.
    expect(invitations.spent).toEqual([{ invitationId: INVITATION, userId: USER }]);
  });

  it('answers the same way for an unknown token as for a spent one', async () => {
    const unknown = new FakeInvitations();
    const spent = new FakeInvitations({ accepted: null });

    await expect(accept(unknown, { resolved: null })).rejects.toBeInstanceOf(
      InvitationNotValidError,
    );
    await expect(accept(spent)).rejects.toBeInstanceOf(InvitationNotValidError);
    // Nothing was created on either path — the spent one rolls back inside the transaction.
    expect(unknown.accounts).toEqual([]);
  });

  it('hashes nothing for a token the resolver does not find', async () => {
    // The expensive work is behind the cheap answer: an argon2id run over 19 MiB for every guessed
    // token is the memory-exhaustion vector `T-IAM-08` names.
    const invitations = new FakeInvitations();

    await expect(accept(invitations, { resolved: null })).rejects.toBeInstanceOf(
      InvitationNotValidError,
    );
    expect(hasher.hashed).toEqual([]);
  });

  it('refuses once the address has spent its budget, before anything is read', async () => {
    const invitations = new FakeInvitations();

    rateLimit = new FakeRateLimit({ limits: { invitation_accept: 0 }, retryAfterSeconds: 900 });

    await expect(accept(invitations)).rejects.toBeInstanceOf(RateLimitedError);
    expect(hasher.hashed).toEqual([]);
    expect(unitOfWork.scopes).toEqual([]);
  });

  it('counts the attempt against the address, which is the only subject there is', async () => {
    await accept(new FakeInvitations());

    expect(rateLimit.consumed).toEqual([
      { policy: 'invitation_accept', subject: { ipAddress: '203.0.113.7' } },
    ]);
  });

  it('records the acceptance without the token', async () => {
    const invitations = new FakeInvitations();

    await accept(invitations);

    expect(audit.events.map((event) => event.action)).toEqual(['invitation.accepted']);
    expect(JSON.stringify(audit.events)).not.toContain('invite-token');
    expect(audit.events[0]?.after).toMatchObject({ email: 'ivan@example.test', roleId: ROLE });
  });

  it('assigns no role when the invitation carried none', async () => {
    const invitations = new FakeInvitations({
      accepted: { email: 'ivan@example.test', roleId: null, teamIds: [] },
    });

    await accept(invitations);

    expect(roles.assigned).toEqual([]);
    expect(invitations.joined).toEqual([{ userId: USER, teamIds: [] }]);
  });

  it('writes one line per attempt, with the masked network and no address', async () => {
    await accept(new FakeInvitations());

    const [line] = logger.lines;

    expect(line?.fields).toMatchObject({
      event: 'invitation_accepted',
      ipMasked: '203.0.113.0/24',
    });
    expect(JSON.stringify(logger.lines)).not.toContain('203.0.113.7');
    expect(JSON.stringify(logger.lines)).not.toContain('ivan@example.test');
  });
});
