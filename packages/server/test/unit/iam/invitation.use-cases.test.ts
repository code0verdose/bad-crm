import { SharedPermissions } from '@bad-crm/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type InvitationDraftRow,
  type InvitationRepositoryPort,
  type InvitationRow,
} from '@/application/iam/ports/invitation-repository.port.js';
import { ListInvitationsQuery } from '@/application/iam/use-cases/list-invitations.query.js';
import {
  CreateInvitationUseCase,
  ResendInvitationUseCase,
  RevokeInvitationUseCase,
} from '@/application/iam/use-cases/write-invitation.use-case.js';
import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
} from '@/domain/shared/errors/app.errors.js';

import {
  FakeClock,
  FakeMail,
  FakeMailDispatcher,
  FakeOrganizations,
  FakeRateLimit,
  FakeResetTokens,
  FakeUnitOfWork,
} from '../../support/identity-doubles.util.js';

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
  readonly listed?: readonly InvitationRow[];
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
    return Promise.resolve(this.state.listed ?? []);
  }

  userExists(): Promise<boolean> {
    return Promise.resolve(this.state.userExists ?? false);
  }

  /** Acceptance is `accept-invitation.use-case.test.ts`; these three are here to satisfy the port. */
  accept(): Promise<null> {
    return Promise.resolve(null);
  }
  createAccount(): Promise<string> {
    throw new Error('not part of creating, resending or revoking');
  }
  joinTeams(): Promise<number> {
    return Promise.resolve(0);
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
  locale: 'ru',
  invitedById: 'admin',
  expiresAt: new Date('2026-08-14T10:00:00.000Z'),
  acceptedAt: null,
  createdAt: new Date('2026-08-07T10:00:00.000Z'),
  ...overrides,
});

const APP_URL = 'https://crm.example.test';

let unitOfWork: FakeUnitOfWork;
let clock: FakeClock;
let tokens: FakeResetTokens;
let organizations: FakeOrganizations;
let rateLimit: FakeRateLimit;
let mail: FakeMail;
let dispatcher: FakeMailDispatcher;
let audit: { events: AuditEvent[]; port: { record: (event: AuditEvent) => Promise<void> } };

beforeEach(() => {
  unitOfWork = new FakeUnitOfWork();
  clock = new FakeClock(new Date('2026-08-07T10:00:00.000Z'));
  tokens = new FakeResetTokens();
  organizations = new FakeOrganizations();
  rateLimit = new FakeRateLimit();
  mail = new FakeMail();
  dispatcher = new FakeMailDispatcher();
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
    new CreateInvitationUseCase(
      unitOfWork,
      invitations,
      organizations,
      tokens,
      clock,
      audit.port,
      rateLimit,
      mail,
      dispatcher,
      APP_URL,
    );

  const invite = (
    invitations: FakeInvitations,
    overrides: Partial<Parameters<CreateInvitationUseCase['execute']>[0]> = {},
  ): ReturnType<CreateInvitationUseCase['execute']> =>
    create(invitations).execute({
      actor: actorWith(),
      email: 'ivan@example.test',
      roleId: ROLE,
      teamIds: [],
      locale: 'en',
      ...overrides,
    });

  it('stores the digest and hands back the link exactly once', async () => {
    const invitations = new FakeInvitations();

    const minted = await invite(invitations, { teamIds: ['team-1'] });
    const token = tokens.minted[0] ?? '';

    expect(minted.inviteUrl).toBe(`${APP_URL}/invite/${token}`);
    // What is stored is the digest. A dump, a backup or a curious operator must not yield a working
    // invitation, which is the whole reason the column is a hash.
    const [stored] = invitations.created;

    expect(stored?.tokenHash).toEqual(tokens.hash(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored).toMatchObject({
      email: 'ivan@example.test',
      roleId: ROLE,
      teamIds: ['team-1'],
      locale: 'en',
    });
    // Seven days, from the clock rather than from `Date.now()` — the application layer may not read
    // a clock of its own.
    expect(stored?.expiresAt).toEqual(new Date('2026-08-14T10:00:00.000Z'));
    expect(unitOfWork.scopes).toEqual([{ organizationId: ORG, userId: 'admin' }]);
  });

  it('keeps the token out of the trail', async () => {
    const invitations = new FakeInvitations();

    await invite(invitations);

    expect(audit.events.map((event) => event.action)).toEqual(['invitation.created']);
    expect(JSON.stringify(audit.events)).not.toContain(tokens.minted[0]);
    expect(audit.events[0]?.after).toMatchObject({ email: 'ivan@example.test', roleId: ROLE });
  });

  it('sends the letter after the transaction has closed, in the chosen language', async () => {
    const invitations = new FakeInvitations();
    let dispatchedInsideTheScope = false;

    unitOfWork.onScopeClosed = (): void => {
      dispatchedInsideTheScope = dispatcher.dispatched.length > 0;
    };

    const minted = await invite(invitations, { locale: 'ru' });

    // SMTP is never touched inside a transaction (`rules/outbox.mdc`, rule 2).
    expect(dispatchedInsideTheScope).toBe(false);
    expect(dispatcher.dispatched).toHaveLength(1);
    expect(minted.mailDispatched).toBe(true);
  });

  it('addresses the letter to the invitee and puts the link in it', async () => {
    const invitations = new FakeInvitations();

    const minted = await invite(invitations, { locale: 'ru' });
    const [letter] = dispatcher.dispatched;

    expect(letter?.mail.to).toBe('ivan@example.test');
    expect(letter?.mail.text).toContain(minted.inviteUrl);
    // Russian, because that is what the inviter was reading — the recipient has no account to take
    // a language from.
    expect(letter?.mail.text).toMatch(/[а-яё]/i);
    // The context names the inviter, never the recipient: the address is what a dispatch log may
    // not carry.
    expect(letter?.context).toMatchObject({ organizationId: ORG, userId: 'admin' });
    expect(JSON.stringify(letter?.context)).not.toContain('ivan@example.test');
  });

  it('creates the invitation anyway when the installation cannot send mail', async () => {
    // NFR-9: no relay is not a failed request. The link is in the response and the inviter passes
    // it on themselves — unlike password recovery, where the link is the person's only way through.
    mail.configured = false;
    const invitations = new FakeInvitations();

    const minted = await invite(invitations);

    expect(minted.mailDispatched).toBe(false);
    expect(dispatcher.dispatched).toEqual([]);
    expect(invitations.created).toHaveLength(1);
    expect(minted.inviteUrl).toContain('/invite/');
  });

  it('refuses once the budget is spent, before anything is written or sent', async () => {
    const invitations = new FakeInvitations();

    rateLimit = new FakeRateLimit({ limits: { invitation_create: 0 }, retryAfterSeconds: 600 });

    await expect(invite(invitations)).rejects.toBeInstanceOf(RateLimitedError);
    expect(invitations.created).toEqual([]);
    expect(dispatcher.dispatched).toEqual([]);
    // Nothing was even looked up: the budget is spent before the address is touched, so the
    // endpoint cannot be walked down a list of addresses to learn who already has an account.
    expect(unitOfWork.scopes).toEqual([]);
  });

  it('counts the invitation against the inviter rather than the address', async () => {
    // The address is the part the caller varies; counting on it would bound nobody.
    await invite(new FakeInvitations());

    expect(rateLimit.consumed).toEqual([
      { policy: 'invitation_create', subject: { userId: 'admin' } },
    ]);
  });

  it('fails loudly when the scope names an organization that is not there', async () => {
    // Unreachable in practice — the caller is authenticated against that very organization — which
    // is why it must be a crash with a sentence rather than a letter addressed to «undefined».
    organizations.forget();

    await expect(invite(new FakeInvitations())).rejects.toThrow(/does not exist/);
  });

  it('refuses a role carrying more than the inviter holds', async () => {
    // `T-IAM-09`: the account this would produce holds rights its author never had.
    const invitations = new FakeInvitations({ rolePermissions: ['invoice:issue'] });

    await expect(invite(invitations)).rejects.toBeInstanceOf(AccessRefusedError);
    expect(invitations.created).toEqual([]);
    expect(dispatcher.dispatched).toEqual([]);
  });

  it('answers 404 for a role of another organization', async () => {
    const invitations = new FakeInvitations({ rolePermissions: null });

    await expect(invite(invitations, { roleId: 'role-of-another-org' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses an address that already has an account', async () => {
    // A different situation from «already invited», with a different thing to do about it.
    const invitations = new FakeInvitations({ userExists: true });

    await expect(invite(invitations, { roleId: null })).rejects.toBeInstanceOf(ConflictError);
    expect(invitations.created).toEqual([]);
  });

  it('allows an invitation with no role, and asks the repository nothing about roles', async () => {
    const invitations = new FakeInvitations({ rolePermissions: null });

    await expect(invite(invitations, { roleId: null })).resolves.toMatchObject({
      invitationId: INVITATION,
    });
  });
});

describe('listing what is still open', () => {
  it('reads inside the tenant scope and returns the rows as they are', async () => {
    const invitations = new FakeInvitations({ listed: [open()] });

    const rows = await new ListInvitationsQuery(unitOfWork, invitations).execute({
      actor: actorWith(),
    });

    expect(rows).toEqual([open()]);
    expect(unitOfWork.scopes).toEqual([{ organizationId: ORG, userId: 'admin' }]);
  });
});

describe('re-issuing the link', () => {
  const resend = (invitations: FakeInvitations): ResendInvitationUseCase =>
    new ResendInvitationUseCase(
      unitOfWork,
      invitations,
      organizations,
      tokens,
      clock,
      audit.port,
      rateLimit,
      mail,
      dispatcher,
      APP_URL,
    );

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
        hash: tokens.hash(tokens.minted[0] ?? ''),
        expiresAt: new Date('2026-08-14T10:00:00.000Z'),
      },
    ]);
    expect(minted.inviteUrl).toBe(`${APP_URL}/invite/${tokens.minted[0] ?? ''}`);
    expect(audit.events.map((event) => event.action)).toEqual(['invitation.resent']);
  });

  it('sends it to the address on the row, in the language of the first attempt', async () => {
    // Not an address from the request: a resend that could be pointed elsewhere would be a way to
    // have somebody else's invitation delivered to an attacker.
    const invitations = new FakeInvitations({ invitation: open({ email: 'olga@example.test' }) });

    await resend(invitations).execute({ actor: actorWith(), invitationId: INVITATION });

    const [letter] = dispatcher.dispatched;

    expect(letter?.mail.to).toBe('olga@example.test');
    expect(letter?.mail.text).toMatch(/[а-яё]/i);
  });

  it('fails loudly when the scope names an organization that is not there', async () => {
    const invitations = new FakeInvitations({ invitation: open() });

    organizations.forget();

    await expect(
      resend(invitations).execute({ actor: actorWith(), invitationId: INVITATION }),
    ).rejects.toThrow(/does not exist/);
  });

  it('spends the same budget as creating one', async () => {
    // A resend mints a token and sends a letter; a second budget would be a way around the first.
    const invitations = new FakeInvitations({ invitation: open() });

    rateLimit = new FakeRateLimit({ limits: { invitation_create: 0 } });

    await expect(
      resend(invitations).execute({ actor: actorWith(), invitationId: INVITATION }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(invitations.reissues).toEqual([]);
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
