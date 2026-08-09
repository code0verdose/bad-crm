import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { FakeInvitationRepository } from '../../support/iam-doubles.util.js';
import { createAuthApp, type AuthApp } from '../../support/auth-app.util.js';

/**
 * `POST /api/v1/invitations/accept` — the one endpoint that creates an account without a session.
 *
 * What only shows up at this level is the wiring: the route is public, the body is strict, the
 * answer is the same document sign-in returns, and the refresh cookie is set. The race is here too,
 * because «exactly one of N concurrent requests wins» is a property of the whole path rather than of
 * any one function in it.
 */

const IDEMPOTENCY_KEY = 'c'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const INVITED = 'ivan@example.test';
const ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ab1';
const TEAM = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ab2';

/**
 * An open invitation, as the repository would hold it after `POST /invitations`.
 *
 * The digest is taken from the app's own token service rather than computed here: the resolver
 * matches on `hash(token)`, and a fixture that stored something else would test nothing but its own
 * arithmetic.
 */
const openInvitation = (
  test: AuthApp,
  invitations: FakeInvitationRepository,
  overrides: { readonly expiresAt?: Date; readonly roleId?: string | null } = {},
): Promise<{ id: string; token: string }> => {
  const token = 'a'.repeat(43);

  return invitations
    .create({
      email: INVITED,
      roleId: overrides.roleId === undefined ? ROLE : overrides.roleId,
      teamIds: [TEAM],
      tokenHash: test.resetTokens.hash(token),
      locale: 'ru',
      invitedById: 'inviter',
      expiresAt: overrides.expiresAt ?? new Date('2099-01-01T00:00:00.000Z'),
    })
    .then((id) => ({ id, token }));
};

const accept = (test: AuthApp, token: string, body: Record<string, unknown> = {}): request.Test =>
  request(test.app)
    .post('/api/v1/invitations/accept')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send({ token, password: PASSWORD, locale: 'ru', ...body });

describe('POST /api/v1/invitations/accept', () => {
  it('creates the account, hands back a session and sets the refresh cookie', async () => {
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({ invitations });
    const { token } = await openInvitation(test, invitations);

    const response = await accept(test, token).expect(201);
    const body = response.body as { status: string; accessToken: string; user: { email: string } };

    expect(body.status).toBe('authenticated');
    expect(body.accessToken).toEqual(expect.any(String));
    // The address of the row, not one from the request: the body has no `email` field at all.
    expect(body.user.email).toBe(INVITED);
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');

    expect(invitations.accounts.get(INVITED)).toMatchObject({ locale: 'ru' });
    expect(invitations.memberships).toEqual([
      { userId: invitations.accounts.get(INVITED)?.userId, teamIds: [TEAM] },
    ]);
  });

  /**
   * A gap the STORY-012-07 gate flagged: `team.member_added` is never filed for a membership created
   * this way, so `invitation.accepted` naming a *count* rather than the team ids meant the trail
   * could not answer «which teams did this account join» at all, ever, for anybody who joined through
   * an invitation. Fixed the same way `team.deleted` was — the entry now carries the ids.
   */
  it('files invitation.accepted with the ids of the teams actually joined', async () => {
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({ invitations });
    const { token } = await openInvitation(test, invitations);

    await accept(test, token).expect(201);

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'invitation.accepted',
      after: { email: INVITED, roleId: ROLE, teamIds: [TEAM] },
    });
  });

  it('is reachable without a session, which is the whole point', async () => {
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({ invitations });
    const { token } = await openInvitation(test, invitations);

    // No `Authorization` header anywhere in this file — the token in the body is the credential.
    const response = await accept(test, token).expect(201);

    expect((response.body as { status: string }).status).toBe('authenticated');
  });

  it('answers 410 for an unknown token', async () => {
    const test = createAuthApp({ invitations: new FakeInvitationRepository() });

    const response = await accept(test, 'b'.repeat(43)).expect(410);

    expect((response.body as { code: string }).code).toBe('invitation_not_valid');
  });

  it('answers 410 for an expired one, in the same shape', async () => {
    // Unknown and expired are one answer: telling them apart would let a holder of a guessed token
    // learn whether it ever existed (`T-IAM-03`).
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({ invitations });
    const { token } = await openInvitation(test, invitations, {
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    });

    const response = await accept(test, token).expect(410);

    expect((response.body as { code: string }).code).toBe('invitation_not_valid');
    // Nothing is asserted about the account here on purpose: the insert that precedes the failed
    // spend is undone by the **transaction**, and this harness has no transaction to undo it with.
    // That the rollback happens is the database's property, exercised by `test/integration/db`.
  });

  it('lets exactly one of six concurrent requests through', async () => {
    // The property the conditional `UPDATE … WHERE accepted_at IS NULL` exists for. A read-then-write
    // would let several pass under READ COMMITTED and create several accounts.
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({ invitations });
    const { token } = await openInvitation(test, invitations);

    const answers = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        request(test.app)
          .post('/api/v1/invitations/accept')
          .set('Idempotency-Key', String(index).padStart(32, '0'))
          .send({ token, password: PASSWORD, locale: 'ru' }),
      ),
    );

    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === 410)).toHaveLength(5);
    expect(invitations.accounts.size).toBe(1);
  });

  it('refuses a second attempt with the same link', async () => {
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({ invitations });
    const { token } = await openInvitation(test, invitations);

    await accept(test, token).expect(201);

    const second = await request(test.app)
      .post('/api/v1/invitations/accept')
      .set('Idempotency-Key', 'd'.repeat(32))
      .send({ token, password: PASSWORD, locale: 'ru' })
      .expect(410);

    expect((second.body as { code: string }).code).toBe('invitation_not_valid');
    // One account, from the one attempt that won.
    expect(invitations.accounts.size).toBe(1);
  });

  it('refuses a body that names an address', async () => {
    // `strictObject` is what turns «we do not read it» into «you cannot send it».
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({ invitations });
    const { token } = await openInvitation(test, invitations);

    const response = await accept(test, token, { email: 'attacker@example.test' }).expect(422);

    expect((response.body as { code: string }).code).toBe('validation_failed');
    expect(invitations.accounts.size).toBe(0);
  });

  it('refuses a password the policy rejects, leaving the link usable', async () => {
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({ invitations });
    const { token } = await openInvitation(test, invitations);

    const refused = await accept(test, token, { password: 'short' }).expect(422);

    expect((refused.body as { code: string }).code).toBe('validation_failed');
    // The link still works: a rejected form is corrected, not restarted.
    const accepted = await accept(test, token).expect(201);

    expect((accepted.body as { status: string }).status).toBe('authenticated');
  });

  it('accepts an invitation that carried no role', async () => {
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({ invitations });
    const { token } = await openInvitation(test, invitations, { roleId: null });

    await accept(test, token).expect(201);
    expect(invitations.accounts.size).toBe(1);
  });

  it('refuses with Retry-After once the address has spent its budget', async () => {
    const invitations = new FakeInvitationRepository();
    const test = createAuthApp({
      invitations,
      rateLimit: { limits: { invitation_accept: 0 }, retryAfterSeconds: 900 },
    });
    const { token } = await openInvitation(test, invitations);

    const response = await accept(test, token).expect(429);

    expect(response.headers['retry-after']).toBe('900');
    expect(invitations.accounts.size).toBe(0);
  });
});
