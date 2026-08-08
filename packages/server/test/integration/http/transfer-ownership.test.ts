import { SharedAudit, type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * Handing the organization over.
 *
 * The property this level exists for is that the operation is **one call** with the whole swap
 * inside it: ownership used to be changeable only by editing the database, and an installation whose
 * founder leaves was otherwise a support ticket. What the tests below pin is who may receive it and
 * what the outgoing owner is left holding — never nothing.
 */

const IDEMPOTENCY_KEY = 'f'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const OWNER = 'ada@example.com';
const HEIR = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ae1';
const STRANGER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ae9';
/** The account `organizations.owner_id` actually names, when the signed-in caller is a delegate. */
const REAL_OWNER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5ae2';

const capabilities = (
  granted: readonly SharedPermissions.PermissionKey[],
): NonNullable<AuthAppOptions['capabilities']> => ({
  isOwner: false,
  granted: [...granted],
  denied: [],
  roleKeys: [],
  permissionsVersion: 1,
});

const signedIn = async (
  options: AuthAppOptions = {},
): Promise<{ test: AuthApp; token: string; userId: string }> => {
  const test = createAuthApp(options);

  await request(test.app)
    .post('/api/v1/auth/register')
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send({
      organization: { name: 'Bad Company', slug: 'bad-company' },
      owner: { email: OWNER, password: PASSWORD },
    })
    .expect(201);

  const response = await request(test.app)
    .post('/api/v1/auth/login')
    .send({ email: OWNER, password: PASSWORD })
    .expect(200);

  const body = response.body as { accessToken: string; user: { id: string } };

  return { test, token: body.accessToken, userId: body.user.id };
};

const seedHeir = (test: AuthApp, ownerId: string, status: string = 'ACTIVE'): void => {
  test.ownership.ownerId = ownerId;
  test.ownership.candidates.set(HEIR, {
    userId: HEIR,
    status: status as 'ACTIVE' | 'SUSPENDED' | 'INVITED',
  });
};

const transfer = (test: AuthApp, token: string, body: Record<string, unknown>) =>
  request(test.app)
    .post('/api/v1/organization/transfer-ownership')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', IDEMPOTENCY_KEY)
    .send(body);

describe('POST /api/v1/organization/transfer-ownership', () => {
  it('CONTROL: hands the organization over and leaves the previous owner an administrator', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    seedHeir(test, userId);

    const body = (await transfer(test, token, { toUserId: HEIR }).expect(200)).body as {
      fromUserId: string;
      toUserId: string;
      previousOwnerRoleKey: string;
    };

    expect(body).toEqual({
      fromUserId: userId,
      toUserId: HEIR,
      // Never nothing: an organization whose founder is left unable to open the administration
      // screen has traded one broken state for another.
      previousOwnerRoleKey: 'admin',
    });
    expect(test.ownership.ownerId).toBe(HEIR);
  });

  it('files the transfer as a CRITICAL audit event, with both ids and the fallback role', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    seedHeir(test, userId);

    await transfer(test, token, { toUserId: HEIR }).expect(200);

    const entry = test.audit.events.at(-1);

    expect(entry).toMatchObject({
      action: 'organization.ownership_transferred',
      before: { ownerId: userId },
      after: { ownerId: HEIR, previousOwnerRoleKey: 'admin' },
    });
    // Severity is derived from the action (`AUDIT_ACTION_SEVERITY`), never passed by the call site —
    // asserted here rather than trusted, because the same catalogue would let this action drift to a
    // lower severity without a single test noticing.
    expect(SharedAudit.severityOf(entry?.action as SharedAudit.AuditAction)).toBe('CRITICAL');
  });

  it('keeps the role the outgoing owner chose', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    seedHeir(test, userId);

    await transfer(test, token, { toUserId: HEIR, previousOwnerRoleKey: 'viewer' }).expect(200);

    expect(test.ownership.transfers[0]).toMatchObject({ previousOwnerRoleKey: 'viewer' });
  });

  it('refuses to hand the organization to its current holder', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    test.ownership.ownerId = userId;
    test.ownership.candidates.set(userId, { userId, status: 'ACTIVE' });

    // A wrong value, not a wrong state: no configuration anywhere would make it right.
    const response = await transfer(test, token, { toUserId: userId }).expect(422);

    expect((response.body as { code: string }).code).toBe('invalid_recipient');
    expect(test.ownership.transfers).toEqual([]);
  });

  it.each(['SUSPENDED', 'INVITED'])('refuses a recipient who is %s', async (status) => {
    // A wrong **state**, with a next step: reactivate them, then transfer. Hence 409 and not 422.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    seedHeir(test, userId, status);

    const response = await transfer(test, token, { toUserId: HEIR }).expect(409);

    expect((response.body as { code: string }).code).toBe('recipient_not_active');
    expect(test.ownership.transfers).toEqual([]);
  });

  it('answers 404 for somebody of another organization', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    test.ownership.ownerId = userId;

    const response = await transfer(test, token, { toUserId: STRANGER }).expect(404);

    expect((response.body as { code: string }).code).toBe('user_not_found');
  });

  it('refuses an administrator who may assign roles but does not own the organization', async () => {
    // `organization:transfer_ownership` is held by `owner` alone (`permission-model.md` §4.1).
    // Somebody who can hand out every role still cannot hand out the one that outranks them all.
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['role:assign', 'user:suspend']),
    });

    seedHeir(test, userId);

    const response = await transfer(test, token, { toUserId: HEIR }).expect(403);

    expect((response.body as { reason: string }).reason).toBe('permission_not_granted');
    expect(test.ownership.transfers).toEqual([]);
  });

  it('refuses a delegate who holds the capability but is not the current owner', async () => {
    // `organization:transfer_ownership` can reach somebody who is not `organizations.owner_id` — a
    // per-user ALLOW override or a custom role, not only the `owner` system role
    // (`permission-model.md` §4.1 states the intent; the capability layer alone does not enforce
    // it). The guard already let this caller through; the use-case is what has to notice they are
    // not the account the organization actually points at.
    const { test, token } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    seedHeir(test, REAL_OWNER);

    const response = await transfer(test, token, { toUserId: HEIR }).expect(403);

    expect(response.body).toMatchObject({ code: 'not_the_owner', reason: 'not_the_owner' });
    expect(test.ownership.transfers).toEqual([]);
    // Nobody's role changed, on a real repository this would be a rolled-back transaction; on the
    // fake it is simply an owner who never moved.
    expect(test.ownership.ownerId).toBe(REAL_OWNER);
  });

  it('refuses the delegate even when the recipient named is the organization’s real owner', async () => {
    // Not a way to launder the operation: handing it "back" to the actual owner does not make the
    // delegate the owner, so the refusal still names that — never `invalid_recipient`, which is true
    // only when the *owner* names themselves.
    const { test, token } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    test.ownership.ownerId = REAL_OWNER;
    test.ownership.candidates.set(REAL_OWNER, { userId: REAL_OWNER, status: 'ACTIVE' });

    const response = await transfer(test, token, { toUserId: REAL_OWNER }).expect(403);

    expect((response.body as { reason: string }).reason).toBe('not_the_owner');
    expect(test.ownership.transfers).toEqual([]);
  });

  it('answers loudly rather than transferring on the caller’s behalf when the organization has no resolvable owner', async () => {
    // A soft-deleted organization, or a broken installation: `currentOwnerId()` finds no row to name
    // inside its own tenant scope. Silently attributing the transfer to whoever happened to ask
    // (the previous behaviour) is exactly what this answers instead of doing.
    const { test, token } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    test.ownership.candidates.set(HEIR, { userId: HEIR, status: 'ACTIVE' });
    // `test.ownership.ownerId` is left at its default, `null`.

    const response = await transfer(test, token, { toUserId: HEIR }).expect(500);

    expect((response.body as { code: string }).code).toBe('internal_error');
    expect(test.ownership.transfers).toEqual([]);
  });

  it('refuses a fallback role nobody could hold', async () => {
    const { test, token, userId } = await signedIn({
      capabilities: capabilities(['organization:transfer_ownership']),
    });

    seedHeir(test, userId);

    const response = await transfer(test, token, {
      toUserId: HEIR,
      previousOwnerRoleKey: 'owner',
    }).expect(422);

    // «Keep being the owner» is not a way to stop being the owner.
    expect((response.body as { code: string }).code).toBe('validation_failed');
  });
});
