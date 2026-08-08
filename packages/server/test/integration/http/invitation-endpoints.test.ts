import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { FakeInvitationRepository } from '../../support/iam-doubles.util.js';
import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * The invitation surface, over HTTP.
 *
 * What this level adds to the use-case suite is everything between the socket and the use-case: the
 * status codes, the shape on the wire, the guard, and the two properties that only exist once a
 * response body exists — **the link is shown exactly once**, and **nothing anywhere carries the
 * digest**.
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'e'.repeat(32);
const ROLE_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a71';

const INVITER: AuthAppOptions['capabilities'] = {
  isOwner: false,
  granted: ['invitation:read', 'invitation:create', 'invitation:resend', 'invitation:revoke'],
  denied: [],
  roleKeys: [],
  permissionsVersion: 1,
};

const signedIn = async (
  options: AuthAppOptions = {},
): Promise<{ test: AuthApp; token: string }> => {
  const test = createAuthApp({ capabilities: INVITER, ...options });

  await request(test.app)
    .post('/api/v1/auth/register')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send({
      organization: { name: 'Bad Company', slug: 'bad-company' },
      owner: { email: 'ada@example.com', password: PASSWORD },
    })
    .expect(201);

  const response = await request(test.app)
    .post('/api/v1/auth/login')
    .send({ email: 'ada@example.com', password: PASSWORD })
    .expect(200);

  return { test, token: (response.body as { accessToken: string }).accessToken };
};

const invite = (test: AuthApp, token: string, body: Record<string, unknown> = {}): request.Test =>
  request(test.app)
    .post('/api/v1/invitations')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send({ email: 'ivan@example.test', locale: 'en', ...body });

describe('POST /api/v1/invitations', () => {
  it('answers 201 with the link, and sends the same link by mail', async () => {
    const { test, token } = await signedIn();

    const response = await invite(test, token, { locale: 'ru', teamIds: [] }).expect(201);
    const body = response.body as { id: string; inviteUrl: string; mailDispatched: boolean };

    expect(body.inviteUrl).toMatch(/\/invite\/[\w-]+$/);
    expect(body.mailDispatched).toBe(true);

    const [letter] = test.dispatcher.dispatched;

    expect(letter?.mail.to).toBe('ivan@example.test');
    expect(letter?.mail.text).toContain(body.inviteUrl);
  });

  it('never puts the digest on the wire, and never shows the link twice', async () => {
    const { test, token } = await signedIn();

    const created = await invite(test, token).expect(201);
    const { id, inviteUrl } = created.body as { id: string; inviteUrl: string };
    const token_ = inviteUrl.split('/').pop() ?? '';

    const listed = await request(test.app)
      .get('/api/v1/invitations')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // The row is on the list; the credential is not — not the token, and not its digest, which the
    // repository does not even select.
    expect(JSON.stringify(listed.body)).toContain(id);
    expect(JSON.stringify(listed.body)).not.toContain(token_);
    expect(JSON.stringify(listed.body)).not.toContain('tokenHash');
    expect(JSON.stringify(listed.body)).not.toContain('inviteUrl');
  });

  it('refuses a role carrying more than the inviter holds, and writes nothing', async () => {
    // `T-IAM-09`: the account this would produce would outrank its author.
    const invitations = new FakeInvitationRepository({ rolePermissions: ['invoice:issue'] });
    const { test, token } = await signedIn({ invitations });

    const response = await invite(test, token, { roleId: ROLE_ID }).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
    expect(invitations.rows.size).toBe(0);
    expect(test.dispatcher.dispatched).toEqual([]);
  });

  it('answers 404 for a role of another organization rather than 403', async () => {
    // The API is not an oracle for what exists in a tenant the caller cannot see.
    const invitations = new FakeInvitationRepository({ rolePermissions: null });
    const { test, token } = await signedIn({ invitations });

    const response = await invite(test, token, { roleId: ROLE_ID }).expect(404);

    expect((response.body as { code: string }).code).toBe('role_not_found');
    expect(invitations.rows.size).toBe(0);
  });

  it('answers 409 when the address already has an account', async () => {
    const invitations = new FakeInvitationRepository({ userExists: true });
    const { test, token } = await signedIn({ invitations });

    const response = await invite(test, token).expect(409);

    expect((response.body as { code: string }).code).toBe('user_already_exists');
  });

  it('answers 409 for a second open invitation to the same address', async () => {
    const { test, token } = await signedIn();

    await invite(test, token).expect(201);

    const response = await request(test.app)
      .post('/api/v1/invitations')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'a'.repeat(32))
      .send({ email: 'ivan@example.test', locale: 'en' })
      .expect(409);

    expect((response.body as { code: string }).code).toBe('invitation_already_exists');
  });

  it('creates the invitation on an installation with no relay, and says so', async () => {
    // NFR-9. The link is in the response either way; what changes is what the screen has to tell
    // the inviter to do with it.
    const { test, token } = await signedIn();

    test.mail.configured = false;

    const response = await invite(test, token).expect(201);

    expect((response.body as { mailDispatched: boolean }).mailDispatched).toBe(false);
    expect(test.dispatcher.dispatched).toEqual([]);
    expect((response.body as { inviteUrl: string }).inviteUrl).toContain('/invite/');
  });

  it('refuses a body with an unknown field instead of ignoring it', async () => {
    const { test, token } = await signedIn();

    const response = await invite(test, token, { role_id: ROLE_ID }).expect(422);

    expect((response.body as { code: string }).code).toBe('validation_failed');
    expect(test.invitations.rows.size).toBe(0);
  });

  it('refuses with Retry-After once the budget is spent', async () => {
    // Two, not twenty: what this level asserts is that the endpoint consults the limiter and turns
    // its refusal into a 429 with the header. That the number is twenty per ten minutes is asserted
    // against the policy table, which is where the number lives.
    const { test, token } = await signedIn({
      rateLimit: { limits: { invitation_create: 1 }, retryAfterSeconds: 600 },
    });

    await invite(test, token).expect(201);

    const refused = await request(test.app)
      .post('/api/v1/invitations')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'b'.repeat(32))
      .send({ email: 'one-too-many@example.test', locale: 'en' })
      .expect(429);

    expect(refused.headers['retry-after']).toBe('600');
  });

  it('is refused without the capability', async () => {
    const { test, token } = await signedIn({
      capabilities: {
        isOwner: false,
        granted: ['invitation:read'],
        denied: [],
        roleKeys: [],
        permissionsVersion: 1,
      },
    });

    const response = await invite(test, token).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
  });
});

describe('POST /api/v1/invitations/{id}/resend', () => {
  it('issues a new link and kills the previous one', async () => {
    const { test, token } = await signedIn();

    const created = await invite(test, token).expect(201);
    const { id, inviteUrl } = created.body as { id: string; inviteUrl: string };
    const before = test.invitations.digests.get(id);

    const resent = await request(test.app)
      .post(`/api/v1/invitations/${id}/resend`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect((resent.body as { inviteUrl: string }).inviteUrl).not.toBe(inviteUrl);
    // The old digest is gone rather than kept beside the new one: an invitation with two live links
    // is a door somebody thinks they closed.
    expect(test.invitations.digests.get(id)).not.toEqual(before);
  });

  it('answers 409 for an invitation that has been accepted', async () => {
    const { test, token } = await signedIn();

    const created = await invite(test, token).expect(201);
    const { id } = created.body as { id: string };

    test.invitations.markAccepted(id);

    const response = await request(test.app)
      .post(`/api/v1/invitations/${id}/resend`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    // A state conflict, not a refusal of the caller: nobody holds a capability that would make
    // re-issuing a link for an account that already exists sensible.
    expect((response.body as { code: string }).code).toBe('invitation_already_accepted');
  });

  it('answers 404 for an invitation nobody here has', async () => {
    const { test, token } = await signedIn();

    const response = await request(test.app)
      .post(`/api/v1/invitations/${ROLE_ID}/resend`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect((response.body as { code: string }).code).toBe('invitation_not_found');
  });
});

describe('DELETE /api/v1/invitations/{id}', () => {
  it('removes the row, so the link stops working', async () => {
    const { test, token } = await signedIn();

    const created = await invite(test, token).expect(201);
    const { id } = created.body as { id: string };

    await request(test.app)
      .delete(`/api/v1/invitations/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect(test.invitations.rows.has(id)).toBe(false);
    expect(test.invitations.digests.has(id)).toBe(false);
  });

  it('answers 404 the second time, exactly like an id that never existed', async () => {
    const { test, token } = await signedIn();

    const created = await invite(test, token).expect(201);
    const { id } = created.body as { id: string };

    await request(test.app)
      .delete(`/api/v1/invitations/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const second = await request(test.app)
      .delete(`/api/v1/invitations/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect((second.body as { code: string }).code).toBe('invitation_not_found');
  });
});
