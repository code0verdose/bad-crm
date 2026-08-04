import { expect, request, test } from '@playwright/test';

import { SEED_ORGANIZATION_A, SEED_ORGANIZATION_B, SEED_PASSWORD } from '../../fixtures/seed-data.js';

/**
 * The promise the whole product rests on, asked of the running system rather than of the SQL.
 *
 * Integration tests prove the policies (`packages/server/test/integration/db/rls-isolation.test.ts`);
 * they cannot prove that the layers above them ask the right question. This file goes through the
 * API a real client uses, with a real session, and tries to reach the other tenant on purpose.
 *
 * Two properties, and the second is the one that decides whether the first means anything:
 *
 *   * a resource of the other organization answers **404, not 403** — a 403 would confirm that the
 *     object exists, turning the API into an oracle over other tenants' identifiers;
 *   * **the positive control**: the same request against one's own resource succeeds. Without it an
 *     endpoint that answers 404 to everybody would pass this file with flying colours.
 *
 * Sessions are the resource this milestone has. As domain entities arrive, they are added here —
 * the shape of the assertion does not change.
 */

const API = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const ORIGIN = (): string => new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

interface Session {
  readonly id: string;
  readonly current: boolean;
}

const signIn = async (email: string) => {
  const context = await request.newContext({
    baseURL: API(),
    extraHTTPHeaders: { origin: ORIGIN() },
  });
  const response = await context.post('/api/v1/auth/login', {
    data: { email, password: SEED_PASSWORD },
  });

  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { accessToken: string; organization: { name: string } };

  return {
    context,
    organization: body.organization,
    headers: { authorization: `Bearer ${body.accessToken}`, origin: ORIGIN() },
  };
};

const sessionsOf = async (
  actor: Awaited<ReturnType<typeof signIn>>,
): Promise<readonly Session[]> => {
  const response = await actor.context.get('/api/v1/auth/sessions', { headers: actor.headers });

  expect(response.ok(), await response.text()).toBe(true);

  return ((await response.json()) as { items: Session[] }).items;
};

test.describe('a session of one organization cannot reach another', () => {
  test('sees only its own organization on sign-in', async () => {
    const [alice, bob] = await Promise.all([
      signIn(SEED_ORGANIZATION_A.owner.email),
      signIn(SEED_ORGANIZATION_B.owner.email),
    ]);

    expect(alice.organization.name).toBe(SEED_ORGANIZATION_A.name);
    expect(bob.organization.name).toBe(SEED_ORGANIZATION_B.name);

    await Promise.all([alice.context.dispose(), bob.context.dispose()]);
  });

  test('lists no session of the other organization', async () => {
    const [alice, bob] = await Promise.all([
      signIn(SEED_ORGANIZATION_A.owner.email),
      signIn(SEED_ORGANIZATION_B.owner.email),
    ]);

    const [mine, theirs] = await Promise.all([sessionsOf(alice), sessionsOf(bob)]);
    const overlap = mine.filter((session) => theirs.some((other) => other.id === session.id));

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    expect(overlap).toEqual([]);

    await Promise.all([alice.context.dispose(), bob.context.dispose()]);
  });

  test('answers 404, not 403, when revoking a session of the other organization', async () => {
    const [alice, bob] = await Promise.all([
      signIn(SEED_ORGANIZATION_A.owner.email),
      signIn(SEED_ORGANIZATION_B.owner.email),
    ]);
    const foreign = (await sessionsOf(bob)).find((session) => session.current);

    expect(foreign).toBeDefined();

    const refused = await alice.context.delete(`/api/v1/auth/sessions/${foreign?.id ?? ''}`, {
      headers: alice.headers,
    });

    expect(refused.status()).toBe(404);

    // And it really was refused: the owner still has the session the other tried to end.
    expect((await sessionsOf(bob)).some((session) => session.id === foreign?.id)).toBe(true);

    await Promise.all([alice.context.dispose(), bob.context.dispose()]);
  });

  /**
   * CONTROL: the same call against one's own session succeeds. Without it, «404 for the other
   * tenant» is satisfied by an endpoint that is simply broken.
   */
  test('CONTROL: revoking a session of its own organization succeeds', async () => {
    const alice = await signIn(SEED_ORGANIZATION_A.owner.email);
    const spare = await signIn(SEED_ORGANIZATION_A.owner.email);
    const target = (await sessionsOf(spare)).find((session) => session.current);

    expect(target).toBeDefined();

    const revoked = await alice.context.delete(`/api/v1/auth/sessions/${target?.id ?? ''}`, {
      headers: alice.headers,
    });

    expect(revoked.ok(), await revoked.text()).toBe(true);
    expect((await sessionsOf(alice)).some((session) => session.id === target?.id)).toBe(false);

    await Promise.all([alice.context.dispose(), spare.context.dispose()]);
  });

  /**
   * The tenant comes from the session and from nowhere else. Asking for the other organization by
   * name during sign-in must be refused exactly like a wrong password — the answer must not become a
   * way to ask which organizations exist on this installation.
   */
  test('ignores an organization named in the request instead of honouring it', async () => {
    const context = await request.newContext({
      baseURL: API(),
      extraHTTPHeaders: { origin: ORIGIN() },
    });

    const response = await context.post('/api/v1/auth/login', {
      data: {
        email: SEED_ORGANIZATION_A.owner.email,
        password: SEED_PASSWORD,
        organizationSlug: SEED_ORGANIZATION_B.slug,
      },
    });

    expect(response.status()).toBe(401);
    expect(await response.text()).not.toContain(SEED_ORGANIZATION_B.name);

    await context.dispose();
  });
});
