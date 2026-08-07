import { SharedPermissions } from '@bad-crm/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type InvitationDraftRow,
  type InvitationRepositoryPort,
  type InvitationRow,
} from '@/application/iam/ports/invitation-repository.port.js';
import {
  CreateInvitationUseCase,
  ResendInvitationUseCase,
  RevokeInvitationUseCase,
} from '@/application/iam/use-cases/write-invitation.use-case.js';
import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { ConflictError, NotFoundError } from '@/domain/shared/errors/app.errors.js';

import { FakeClock, FakeResetTokens, FakeUnitOfWork } from '../../support/identity-doubles.util.js';

/**
 * Inviting somebody, re-issuing the link and closing it early.
 *
 * The properties that carry the story are all about the **token**: it is a credential, so it exists
 * once in the response and never in the store, never in the trail, and a resend has to kill the
 * previous one rather than add a second. The rest is the subset rule, which an invitation inherits
 * because it is a role assignment written in advance.
 */

const ORG = 'org-1';
const ROLE = 'role-1';
const INVITATION = 'invitation-1';

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'admin',
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>([
    'invitation:create',
    'invitation:resend',
    'invitation:revoke',
    'task:read',
  ]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

interface FakeState {
  readonly rolePermissions?: readonly SharedPermissions.PermissionKey[] | null;
  readonly invitation?: InvitationRow | null;
  readonly userExists?: boolean;
  readonly reissued?: boolean;
  readonly removed?: boolean;
}

/** A repository that records what it was asked to store — the trail a test reads instead of a table. */
class FakeInvitations implements InvitationRepositoryPort {
  readonly created: InvitationDraftRow[] = [];
  readonly reissues: { id: string; hash: Uint8Array; expiresAt: Date }[] = [];
  readonly removals: string[] = [];

  constructor(private readonly state: FakeState = {}) {}

  create(draft: InvitationDraftRow): Promise<string> {
    this.created.push(draft);

    return Promise.resolve(INVITATION);
  }

  byId(): Promise<InvitationRow | null> {
    return Promise.resolve(this.state.invitation ?? null);
  }

  reissue(invitationId: string, tokenHash: Uint8Array, expiresAt: Date): Promise<boolean> {
    this.reissues.push({ id: invitationId, hash: tokenHash, expiresAt });

    return Promise.resolve(this.state.reissued ?? true);
  }

  remove(invitationId: string): Promise<boolean> {
    this.removals.push(invitationId);

    return Promise.resolve(this.state.removed ?? true);
  }

  listOpen(): Promise<readonly InvitationRow[]> {
    return Promise.resolve([]);
  }

  userExists(): Promise<boolean> {
    return Promise.resolve(this.state.userExists ?? false);
  }

  rolePermissions(): Promise<readonly SharedPermissions.PermissionKey[] | null> {
    // `??` would fold «the state says this role does not exist here» into the default, and the
    // 404 case would quietly test the happy path instead.
    return Promise.resolve(
      'rolePermissions' in this.state ? (this.state.rolePermissions ?? null) : ['task:read'],
    );
  }
}

const open = (overrides: Partial<InvitationRow> = {}): InvitationRow => ({
  id: INVITATION,
  email: 'ivan@example.test',
  roleId: ROLE,
  teamIds: [],
  invitedById: 'admin',
  expiresAt: new Date('2026-08-14T10:00:00.000Z'),
  acceptedAt: null,
  createdAt: new Date('2026-08-07T10:00:00.000Z'),
  ...overrides,
});

let unitOfWork: FakeUnitOfWork;
let clock: FakeClock;
let tokens: FakeResetTokens;
let audit: { events: AuditEvent[]; port: { record: (event: AuditEvent) => Promise<void> } };

beforeEach(() => {
  unitOfWork = new FakeUnitOfWork();
  clock = new FakeClock(new Date('2026-08-07T10:00:00.000Z'));
  tokens = new FakeResetTokens();
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

describe('inviting somebody', () => {
  const create = (invitations: FakeInvitations): CreateInvitationUseCase =>
    new CreateInvitationUseCase(unitOfWork, invitations, tokens, clock, audit.port);

  it('stores the digest and hands back the token exactly once', async () => {
    const invitations = new FakeInvitations();

    const minted = await create(invitations).execute({
      actor: actorWith(),
      email: 'ivan@example.test',
      roleId: ROLE,
      teamIds: ['team-1'],
    });

    expect(minted.token).toBe(tokens.minted[0]);
    // What is stored is the digest. A dump, a backup or a curious operator must not yield a working
    // invitation, which is the whole reason the column is a hash.
    const [stored] = invitations.created;

    expect(stored?.tokenHash).toEqual(tokens.hash(minted.token));
    expect(JSON.stringify(stored)).not.toContain(minted.token);
    expect(stored).toMatchObject({ email: 'ivan@example.test', roleId: ROLE, teamIds: ['team-1'] });
    // Seven days, from the clock rather than from `Date.now()` — the application layer may not read
    // a clock of its own.
    expect(stored?.expiresAt).toEqual(new Date('2026-08-14T10:00:00.000Z'));
    expect(unitOfWork.scopes).toEqual([{ organizationId: ORG, userId: 'admin' }]);
  });

  it('keeps the token out of the trail', async () => {
    const invitations = new FakeInvitations();

    const minted = await create(invitations).execute({
      actor: actorWith(),
      email: 'ivan@example.test',
      roleId: ROLE,
      teamIds: [],
    });

    expect(audit.events.map((event) => event.action)).toEqual(['invitation.created']);
    expect(JSON.stringify(audit.events)).not.toContain(minted.token);
    expect(audit.events[0]?.after).toMatchObject({ email: 'ivan@example.test', roleId: ROLE });
  });

  it('refuses a role carrying more than the inviter holds', async () => {
    // `T-IAM-09`: the account this would produce holds rights its author never had.
    const invitations = new FakeInvitations({ rolePermissions: ['invoice:issue'] });

    await expect(
      create(invitations).execute({
        actor: actorWith(),
        email: 'ivan@example.test',
        roleId: ROLE,
        teamIds: [],
      }),
    ).rejects.toBeInstanceOf(AccessRefusedError);
    expect(invitations.created).toEqual([]);
  });

  it('answers 404 for a role of another organization', async () => {
    const invitations = new FakeInvitations({ rolePermissions: null });

    await expect(
      create(invitations).execute({
        actor: actorWith(),
        email: 'ivan@example.test',
        roleId: 'role-of-another-org',
        teamIds: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an address that already has an account', async () => {
    // A different situation from «already invited», with a different thing to do about it.
    const invitations = new FakeInvitations({ userExists: true });

    await expect(
      create(invitations).execute({
        actor: actorWith(),
        email: 'ivan@example.test',
        roleId: null,
        teamIds: [],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(invitations.created).toEqual([]);
  });

  it('allows an invitation with no role, and asks the repository nothing about roles', async () => {
    const invitations = new FakeInvitations({ rolePermissions: null });

    await expect(
      create(invitations).execute({
        actor: actorWith(),
        email: 'ivan@example.test',
        roleId: null,
        teamIds: [],
      }),
    ).resolves.toMatchObject({ invitationId: INVITATION });
  });
});

describe('re-issuing the link', () => {
  const resend = (invitations: FakeInvitations): ResendInvitationUseCase =>
    new ResendInvitationUseCase(unitOfWork, invitations, tokens, clock, audit.port);

  it('mints a new token and moves the expiry', async () => {
    const invitations = new FakeInvitations({ invitation: open() });

    const minted = await resend(invitations).execute({
      actor: actorWith(),
      invitationId: INVITATION,
    });

    // The old digest is replaced in the same statement: an invitation with two live tokens is a
    // door somebody thinks they closed.
    expect(invitations.reissues).toEqual([
      {
        id: INVITATION,
        hash: tokens.hash(minted.token),
        expiresAt: new Date('2026-08-14T10:00:00.000Z'),
      },
    ]);
    expect(audit.events.map((event) => event.action)).toEqual(['invitation.resent']);
  });

  it('refuses one that has been accepted', async () => {
    // It is a person now. Re-issuing would mint a token for an account that already exists.
    const invitations = new FakeInvitations({
      invitation: open({ acceptedAt: new Date('2026-08-06T10:00:00.000Z') }),
    });

    await expect(
      resend(invitations).execute({ actor: actorWith(), invitationId: INVITATION }),
    ).rejects.toBeInstanceOf(AccessRefusedError);
    expect(invitations.reissues).toEqual([]);
  });

  it('answers 404 for an invitation of another organization', async () => {
    const invitations = new FakeInvitations({ invitation: null });

    await expect(
      resend(invitations).execute({ actor: actorWith(), invitationId: INVITATION }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers 404 when it disappears between the read and the write', async () => {
    const invitations = new FakeInvitations({ invitation: open(), reissued: false });

    await expect(
      resend(invitations).execute({ actor: actorWith(), invitationId: INVITATION }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(audit.events).toEqual([]);
  });
});

describe('closing it early', () => {
  const revoke = (invitations: FakeInvitations): RevokeInvitationUseCase =>
    new RevokeInvitationUseCase(unitOfWork, invitations, audit.port);

  it('removes the row, so the token stops working', async () => {
    const invitations = new FakeInvitations({ invitation: open() });

    await revoke(invitations).execute({ actor: actorWith(), invitationId: INVITATION });

    expect(invitations.removals).toEqual([INVITATION]);
    expect(audit.events.map((event) => event.action)).toEqual(['invitation.revoked']);
    expect(audit.events[0]?.before).toMatchObject({ email: 'ivan@example.test', roleId: ROLE });
  });

  it('refuses one that has been accepted', async () => {
    const invitations = new FakeInvitations({
      invitation: open({ acceptedAt: new Date('2026-08-06T10:00:00.000Z') }),
    });

    await expect(
      revoke(invitations).execute({ actor: actorWith(), invitationId: INVITATION }),
    ).rejects.toBeInstanceOf(AccessRefusedError);
    expect(invitations.removals).toEqual([]);
  });

  it('answers 404 when it disappears between the read and the write', async () => {
    const invitations = new FakeInvitations({ invitation: open(), removed: false });

    await expect(
      revoke(invitations).execute({ actor: actorWith(), invitationId: INVITATION }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(audit.events).toEqual([]);
  });

  it('needs its own capability', async () => {
    const invitations = new FakeInvitations({ invitation: open() });
    const cannot = actorWith({ permissions: new Set(['invitation:create']) });

    await expect(
      revoke(invitations).execute({ actor: cannot, invitationId: INVITATION }),
    ).rejects.toBeInstanceOf(AccessRefusedError);
    expect(invitations.removals).toEqual([]);
  });
});
