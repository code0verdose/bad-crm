import { SharedAudit, type SharedPermissions } from '@bad-crm/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { FakeTeamRepository } from '../../support/iam-doubles.util.js';
import { createAuthApp, type AuthApp, type AuthAppOptions } from '../../support/auth-app.util.js';

/**
 * Teams over the wire — STORY-012-07, acceptance 1, 2, 5, 7, 8, 9 and 10.
 *
 * A `Team` is an **org-structure** entity and not a group of access (acceptance 10): nothing is
 * granted by belonging to one, which is why no assertion here is about a permission somebody gained.
 * What is asserted instead is the mechanism that will carry such a grant when `ResourceAcl` exists —
 * the permission version of the people concerned is bumped in the same transaction, so a folded view
 * minted before the change stops being trusted.
 *
 * Acceptance 3, 4 and 6 are not covered and cannot be: they describe a team as the subject of a
 * `ResourceAcl`, and neither the table nor `resolveAcl` exists (STORY-011-06, blocked). See the story
 * file, «Расхождение с этой спекой».
 */

const PASSWORD = 'correct-horse-battery';
const IDEMPOTENCY_KEY = 'e'.repeat(32);
/** Uuids, because the path parameters are branded ones: the schema refuses anything else. */
const TEAM_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a71';
const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a72';
const PETR = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a73';

const ADMIN = {
  isOwner: false,
  granted: [
    'team:read',
    'team:create',
    'team:update',
    'team:delete',
    'team:manage_members',
  ] as SharedPermissions.PermissionKey[],
  denied: [] as SharedPermissions.PermissionKey[],
  roleKeys: [] as string[],
  permissionsVersion: 1,
};

const signedIn = async (
  options: AuthAppOptions = {},
): Promise<{ test: AuthApp; token: string }> => {
  const test = createAuthApp(options);

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

/** An administrator of teams, over a repository the caller can seed and read back. */
const admin = (
  teams = new FakeTeamRepository(),
): AuthAppOptions & { teams: FakeTeamRepository } => ({
  capabilities: { ...ADMIN, granted: [...ADMIN.granted] },
  teams,
});

const seeded = (): FakeTeamRepository => {
  const teams = new FakeTeamRepository();

  teams.seed({ teamId: TEAM_ID, name: 'Backend', slug: 'backend' });
  teams.subjects.set(IVAN, { userId: IVAN, status: 'ACTIVE' });
  teams.subjects.set(PETR, { userId: PETR, status: 'ACTIVE' });

  return teams;
};

describe('POST /api/v1/teams', () => {
  it('creates a team and files team.created', async () => {
    const teams = new FakeTeamRepository();
    const { test, token } = await signedIn(admin(teams));

    const response = await request(test.app)
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ name: 'Backend', slug: 'backend', description: 'Ships the API' })
      .expect(201);

    // The team comes back whole, not the id alone: a client that only got an id could not tell a
    // value stored as sent from one normalised on the way in — and the slug *is* normalised.
    expect(response.body).toEqual({
      id: expect.any(String),
      name: 'Backend',
      slug: 'backend',
      description: 'Ships the API',
    });

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'team.created',
      target: { type: 'TEAM' },
      after: { name: 'Backend', slug: 'backend' },
    });
  });

  /** Acceptance 1: the slug is an identifier, so `" Back-End "` and `back-end` are one team. */
  it('normalises the slug rather than storing two spellings of one team', async () => {
    const { test, token } = await signedIn(admin());

    const response = await request(test.app)
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ name: 'Backend', slug: '  Back-End  ' })
      .expect(201);

    expect(response.body).toMatchObject({ slug: 'back-end' });
  });

  /**
   * Acceptance 1, and the fail-closed half of it: a team with no name is not a team. Refused at the
   * boundary rather than stored as an empty string that every screen then has to render as
   * something.
   */
  it.each([
    ['an empty name', { name: '', slug: 'backend' }],
    ['a name of nothing but spaces', { name: '   ', slug: 'backend' }],
    ['an empty slug', { name: 'Backend', slug: '' }],
    ['a slug that is not URL-safe', { name: 'Backend', slug: 'Back End!' }],
    ['a slug with a double hyphen', { name: 'Backend', slug: 'back--end' }],
    ['a name beyond the declared limit', { name: 'x'.repeat(121), slug: 'backend' }],
    ['an unknown field', { name: 'Backend', slug: 'backend', leadId: IVAN }],
  ])('refuses %s', async (_case, body) => {
    const { test, token } = await signedIn(admin());

    const response = await request(test.app)
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(body)
      .expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });

  /**
   * `leadId` is in the story's request body and not in this API, and the case above pins that: the
   * lead is `team_members.team_role = 'LEAD'`, and accepting a second model of the same fact is how
   * the two stop agreeing. See the story file, «Расхождение с этой спекой».
   */
  it('answers 409 when the slug is taken inside the organization', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted] },
      teams: new FakeTeamRepository({ duplicateSlug: true }),
    });

    const response = await request(test.app)
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ name: 'Backend', slug: 'backend' })
      .expect(409);

    expect(response.body).toMatchObject({ code: 'team_already_exists' });
  });

  /** Acceptance 8. */
  it('needs the capability', async () => {
    const { test, token } = await signedIn();

    const response = await request(test.app)
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ name: 'Backend', slug: 'backend' })
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });

  /** `team:create` is not `team:update`: five keys, five grants (acceptance 8). */
  it('refuses an author who holds only the other team keys', async () => {
    const { test, token } = await signedIn({
      capabilities: {
        ...ADMIN,
        granted: ['team:read', 'team:update', 'team:delete', 'team:manage_members'],
      },
    });

    const response = await request(test.app)
      .post('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ name: 'Backend', slug: 'backend' })
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});

describe('GET /api/v1/teams', () => {
  it('returns every live team with how many people are on it', async () => {
    const teams = seeded();

    await teams.addMember(TEAM_ID, IVAN, 'LEAD');
    teams.seed({ teamId: 'gone', name: 'Growth', slug: 'growth', isDeleted: true });

    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: ['team:read'] },
      teams,
    });

    const response = await request(test.app)
      .get('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // The disbanded team is absent, and it is absent from the *query* rather than filtered out of
    // the response: a list and a count computed from different sets is how the two disagree.
    expect(response.body).toEqual({
      items: [
        {
          id: TEAM_ID,
          name: 'Backend',
          slug: 'backend',
          description: null,
          memberCount: 1,
        },
      ],
    });
  });

  /** Acceptance 1, fail-closed on the empty case: no teams is an empty list, not an error. */
  it('answers an empty list when the organization has no teams', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: ['team:read'] },
    });

    const response = await request(test.app)
      .get('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({ items: [] });
  });

  it('needs the capability', async () => {
    const { test, token } = await signedIn();

    const response = await request(test.app)
      .get('/api/v1/teams')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});

describe('GET /api/v1/teams/{teamId}', () => {
  it('returns the roster as user ids, without names', async () => {
    const teams = seeded();

    await teams.addMember(TEAM_ID, IVAN, 'LEAD');
    await teams.addMember(TEAM_ID, PETR, 'MEMBER');

    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: ['team:read'] },
      teams,
    });

    const response = await request(test.app)
      .get(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      id: TEAM_ID,
      name: 'Backend',
      slug: 'backend',
      description: null,
      memberCount: 2,
      members: [
        { userId: IVAN, teamRole: 'LEAD', joinedAt: expect.any(String) },
        { userId: PETR, teamRole: 'MEMBER', joinedAt: expect.any(String) },
      ],
    });
  });

  /** Acceptance 1, fail-closed: a team nobody is on is a team, not an error. */
  it('returns a team with no members as an empty roster', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: ['team:read'] },
      teams: seeded(),
    });

    const response = await request(test.app)
      .get(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({ memberCount: 0, members: [] });
  });

  /** Acceptance 7: a team of another organization is not visible to this tenant's policy. */
  it('answers 404 for a team this organization cannot see', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: ['team:read'] },
    });

    const response = await request(test.app)
      .get(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'team_not_found' });
  });

  /**
   * The soft deletion must not be observable. The row survives so the slug can be reused; a caller
   * who could tell «disbanded» from «never existed» would be reading a fact about data they cannot
   * see the moment ids are guessed rather than known.
   */
  it('answers 404 for a disbanded team, not a conflict', async () => {
    const teams = new FakeTeamRepository();

    teams.seed({ teamId: TEAM_ID, isDeleted: true });

    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: ['team:read'] },
      teams,
    });

    const response = await request(test.app)
      .get(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'team_not_found' });
  });

  /**
   * Acceptance 7 and 8 together, and the ordering that makes them different answers: a caller who
   * lacks the capability is refused **403** even for an id that does not exist, because the guard
   * runs before anything is read. Only a caller who may read teams learns that this one is absent.
   */
  it('answers 403, not 404, when the caller may not read teams at all', async () => {
    const { test, token } = await signedIn();

    const response = await request(test.app)
      .get(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});

describe('PATCH /api/v1/teams/{teamId}', () => {
  it('replaces the team and files team.updated with both sides', async () => {
    const teams = seeded();
    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .patch(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Platform', slug: 'platform' })
      .expect(204);

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'team.updated',
      target: { type: 'TEAM', id: TEAM_ID },
      before: { name: 'Backend', slug: 'backend' },
      after: { name: 'Platform', slug: 'platform' },
    });
  });

  /** Replace, not merge: a description left out is cleared rather than kept. */
  it('clears a description the body leaves out', async () => {
    const teams = new FakeTeamRepository();

    teams.seed({ teamId: TEAM_ID, name: 'Backend', slug: 'backend', description: 'Ships the API' });

    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .patch(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Backend', slug: 'backend' })
      .expect(204);

    await expect(teams.detail(TEAM_ID)).resolves.toMatchObject({ description: null });
  });

  /**
   * Renaming moves nobody between teams, so nobody's folded view stops being valid. Bumping anyway
   * would answer 401 to every member at once and send them all into refresh together — a load spike
   * on the most sensitive endpoint, bought for nothing.
   */
  it('bumps nobody: a rename is not a membership change', async () => {
    const teams = seeded();

    await teams.addMember(TEAM_ID, IVAN, 'MEMBER');

    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .patch(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Platform', slug: 'platform' })
      .expect(204);

    expect(teams.versionBumps).toEqual([]);
  });

  /** Acceptance 7. */
  it('answers 404 for a team this organization cannot see', async () => {
    const { test, token } = await signedIn(admin());

    const response = await request(test.app)
      .patch(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Platform', slug: 'platform' })
      .expect(404);

    expect(response.body).toMatchObject({ code: 'team_not_found' });
  });

  /**
   * The write side of `uq_teams_org_slug` a rename can hit: `create` already had a 409 case, `update`
   * had none — the coverage gate found the gap and a mutant dropping the `P2002` translation for
   * `updateMany` specifically would have gone unnoticed.
   */
  it('answers 409 when the new slug collides with another live team of this organization', async () => {
    const teams = seeded();

    teams.seed({ teamId: 'growth-team', name: 'Growth', slug: 'growth' });

    const { test, token } = await signedIn(admin(teams));

    const response = await request(test.app)
      .patch(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Backend', slug: 'growth' })
      .expect(409);

    expect(response.body).toMatchObject({ code: 'team_already_exists' });
    // Refused before anything changed: the team being renamed keeps its own slug.
    await expect(teams.detail(TEAM_ID)).resolves.toMatchObject({ slug: 'backend' });
    expect(test.audit.events.filter((event) => event.action === 'team.updated')).toEqual([]);
  });

  /**
   * The concurrent-delete window: the team was there when the decision was made and gone by the
   * time the statement ran. The answer is the 404 a team of another organization gets, because from
   * outside the two are the same — and no `team.updated` entry is filed for a change that did not
   * happen.
   */
  it('answers 404 when the team is disbanded between the decision and the write', async () => {
    const teams = new FakeTeamRepository({ vanishesBeforeWrite: true });

    teams.seed({ teamId: TEAM_ID, name: 'Backend', slug: 'backend' });

    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted] },
      teams,
    });

    const response = await request(test.app)
      .patch(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Platform', slug: 'platform' })
      .expect(404);

    expect(response.body).toMatchObject({ code: 'team_not_found' });
    expect(test.audit.events.filter((event) => event.action === 'team.updated')).toEqual([]);
  });

  /** Acceptance 8. */
  it('needs team:update, which team:read is not', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: ['team:read'] },
      teams: seeded(),
    });

    const response = await request(test.app)
      .patch(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Platform', slug: 'platform' })
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});

describe('DELETE /api/v1/teams/{teamId}', () => {
  /** Acceptance 5, minus the ACL cascade that has nothing to cascade over. */
  it('disbands the team, removes every membership and bumps all of them at once', async () => {
    const teams = seeded();

    await teams.addMember(TEAM_ID, IVAN, 'LEAD');
    await teams.addMember(TEAM_ID, PETR, 'MEMBER');

    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // Both former members, and both from a single call: the port takes a list precisely so that
    // disbanding a fifty-person team is one statement rather than fifty round trips inside a
    // transaction with a five-second ceiling.
    expect(teams.versionBumps).toEqual([IVAN, PETR]);
    await expect(teams.list()).resolves.toEqual([]);

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'team.deleted',
      target: { type: 'TEAM', id: TEAM_ID },
      // The roster, each with the role they held: `team_members` has no `deleted_at`, so this entry
      // is the only place that ever answers «who was on that team, and as what» again.
      before: {
        name: 'Backend',
        members: [
          { userId: IVAN, teamRole: 'LEAD' },
          { userId: PETR, teamRole: 'MEMBER' },
        ],
      },
    });
    // Severity is derived from the action, never passed by the call site — pinned here so a
    // regression to `INFO` (the level `team.created`/`team.updated` read at) is caught by this
    // suite rather than only by the generic «every action has a known severity» sweep.
    expect(SharedAudit.severityOf('team.deleted')).toBe('WARNING');
  });

  /** Fail-closed on the empty case: disbanding a team nobody is on bumps nobody and still records. */
  it('disbands a team with no members without bumping anybody', async () => {
    const teams = seeded();
    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect(teams.versionBumps).toEqual([]);
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'team.deleted',
      before: { members: [] },
    });
  });

  /** Disbanding twice is not two deletions: the second finds nothing live and files nothing. */
  it('answers 404 the second time and files one entry, not two', async () => {
    const teams = seeded();
    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(test.audit.events.filter((event) => event.action === 'team.deleted')).toHaveLength(1);
  });

  /** Acceptance 7. */
  it('answers 404 for a team this organization cannot see', async () => {
    const { test, token } = await signedIn(admin());

    const response = await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'team_not_found' });
  });

  /**
   * The same window on the delete path. Two administrators disbanding one team at once must produce
   * one `team.deleted` entry, not two — the trail would otherwise say the team was disbanded twice,
   * and the second entry would carry a member count somebody else's transaction had already emptied.
   */
  it('answers 404 when the team is disbanded between the decision and the write', async () => {
    const teams = new FakeTeamRepository({ vanishesBeforeWrite: true });

    teams.seed({ teamId: TEAM_ID, name: 'Backend', slug: 'backend' });

    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: [...ADMIN.granted] },
      teams,
    });

    const response = await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'team_not_found' });
    expect(test.audit.events.filter((event) => event.action === 'team.deleted')).toEqual([]);
  });

  /** Acceptance 8: disbanding is its own grant, not a corollary of editing. */
  it('needs team:delete, which team:update is not', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: ['team:read', 'team:update'] },
      teams: seeded(),
    });

    const response = await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});

describe('POST /api/v1/teams/{teamId}/members', () => {
  /** Acceptance 2. */
  it('writes the membership and bumps that person, in the same transaction', async () => {
    const teams = seeded();
    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .post(`/api/v1/teams/${TEAM_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ userId: IVAN })
      .expect(204);

    // That person, and nobody else: a membership change is about one account.
    expect(teams.versionBumps).toEqual([IVAN]);

    await expect(teams.detail(TEAM_ID)).resolves.toMatchObject({
      members: [{ userId: IVAN, teamRole: 'MEMBER' }],
    });

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'team.member_added',
      target: { type: 'TEAM', id: TEAM_ID },
      after: { userId: IVAN, teamRole: 'MEMBER' },
    });
  });

  /**
   * The lead, as the schema actually stores one. `Team` has no `lead_id` column: the role is
   * `team_members.team_role`, constrained by `ck_team_members_role`.
   */
  it('writes a lead as a membership with teamRole LEAD', async () => {
    const teams = seeded();
    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .post(`/api/v1/teams/${TEAM_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ userId: IVAN, teamRole: 'LEAD' })
      .expect(204);

    await expect(teams.detail(TEAM_ID)).resolves.toMatchObject({
      members: [{ userId: IVAN, teamRole: 'LEAD' }],
    });
  });

  /**
   * The gate's L-3. Before the fix a repeat `POST` with a different `teamRole` was folded into the
   * same idempotent no-op a repeat with the *same* role gets, which made promoting an existing member
   * to `LEAD` impossible through this API — the only place `teamRole` can be set at all
   * (`manage-team-members.use-case.ts`, «Расхождение с этой спекой»). It now changes the row in
   * place, bumps the person's permission version and files a `team.member_role_changed` entry with
   * both sides of the change.
   */
  it('changes the role in place on a repeat request with a different teamRole', async () => {
    const teams = seeded();

    await teams.addMember(TEAM_ID, IVAN, 'MEMBER');

    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .post(`/api/v1/teams/${TEAM_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ userId: IVAN, teamRole: 'LEAD' })
      .expect(204);

    await expect(teams.detail(TEAM_ID)).resolves.toMatchObject({
      members: [{ userId: IVAN, teamRole: 'LEAD' }],
    });
    expect(teams.versionBumps).toEqual([IVAN]);
    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'team.member_role_changed',
      target: { type: 'TEAM', id: TEAM_ID },
      before: { userId: IVAN, teamRole: 'MEMBER' },
      after: { userId: IVAN, teamRole: 'LEAD' },
    });
    // Not a second `team.member_added`: the membership already existed, only the role moved.
    expect(test.audit.events.filter((event) => event.action === 'team.member_added')).toEqual([]);
  });

  it('refuses a team role the CHECK constraint would refuse', async () => {
    const { test, token } = await signedIn(admin(seeded()));

    const response = await request(test.app)
      .post(`/api/v1/teams/${TEAM_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ userId: IVAN, teamRole: 'OWNER' })
      .expect(422);

    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });

  /**
   * Acceptance 2: `uq_team_members (team_id, user_id)` admits no duplicates. The repeat succeeds and
   * costs nothing — no second trail entry, and no second bump, which would send the person into a
   * refresh for a membership that did not change.
   */
  it('is idempotent: the second request adds no entry and no bump', async () => {
    const teams = seeded();
    const { test, token } = await signedIn(admin(teams));

    for (const key of ['a'.repeat(32), 'b'.repeat(32)]) {
      await request(test.app)
        .post(`/api/v1/teams/${TEAM_ID}/members`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ userId: IVAN })
        .expect(204);
    }

    expect(teams.versionBumps).toEqual([IVAN]);
    expect(test.audit.events.filter((event) => event.action === 'team.member_added')).toHaveLength(
      1,
    );
  });

  /**
   * Acceptance 9. Offboarding takes somebody off every team precisely so that a deactivated account
   * is on none (STORY-012-05); accepting them here would undo that one row at a time. A 409 rather
   * than a 403 because the request is well formed and there is a next step — reactivate them first.
   *
   * Gated on `user:read`, added to `ADMIN` explicitly here rather than folded into it: the point of
   * this case is the *informative* answer a directory-holding caller still gets, and the case right
   * after it is what a caller without that key gets instead.
   */
  it.each(['SUSPENDED', 'INVITED'] as const)(
    'refuses a %s account with 409, for a caller who also holds user:read',
    async (status) => {
      const teams = seeded();

      teams.subjects.set(IVAN, { userId: IVAN, status });

      const { test, token } = await signedIn({
        capabilities: { ...ADMIN, granted: [...ADMIN.granted, 'user:read'] },
        teams,
      });

      const response = await request(test.app)
        .post(`/api/v1/teams/${TEAM_ID}/members`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .send({ userId: IVAN })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'member_not_active' });
      // Nothing was written and nobody was invalidated: the refusal is before the write.
      expect(teams.versionBumps).toEqual([]);
      expect(test.audit.events.filter((event) => event.action === 'team.member_added')).toEqual([]);
    },
  );

  /**
   * The gate's L-1. `admin()` grants `team:manage_members` and `team:read` but not `user:read` —
   * `team:manage_members` says nothing about being allowed to look somebody up in the directory, and
   * the previous case's 409 would otherwise let its holder learn *which* inactive state any account
   * in the organization is in, whether or not that account is on a team this caller administers. The
   * answer collapses into the same 404 a foreign account gets.
   */
  it.each(['SUSPENDED', 'INVITED'] as const)(
    'answers 404, not 409, for a %s account when the caller may not read the directory',
    async (status) => {
      const teams = seeded();

      teams.subjects.set(IVAN, { userId: IVAN, status });

      const { test, token } = await signedIn(admin(teams));

      const response = await request(test.app)
        .post(`/api/v1/teams/${TEAM_ID}/members`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .send({ userId: IVAN })
        .expect(404);

      expect(response.body).toMatchObject({ code: 'user_not_found' });
      expect(teams.versionBumps).toEqual([]);
      expect(test.audit.events.filter((event) => event.action === 'team.member_added')).toEqual([]);
    },
  );

  /** Acceptance 7, the subject half: a person of another organization is 404, not 403. */
  it('answers 404 for a subject this organization cannot see', async () => {
    const teams = new FakeTeamRepository();

    teams.seed({ teamId: TEAM_ID });

    const { test, token } = await signedIn(admin(teams));

    const response = await request(test.app)
      .post(`/api/v1/teams/${TEAM_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ userId: IVAN })
      .expect(404);

    expect(response.body).toMatchObject({ code: 'user_not_found' });
  });

  /** Acceptance 7, the team half. */
  it('answers 404 for a team this organization cannot see', async () => {
    const { test, token } = await signedIn(admin());

    const response = await request(test.app)
      .post(`/api/v1/teams/${TEAM_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ userId: IVAN })
      .expect(404);

    expect(response.body).toMatchObject({ code: 'team_not_found' });
  });

  /** Acceptance 8: deciding who is on a team is a separate grant from renaming it. */
  it('needs team:manage_members, which team:update is not', async () => {
    const { test, token } = await signedIn({
      capabilities: { ...ADMIN, granted: ['team:read', 'team:update'] },
      teams: seeded(),
    });

    const response = await request(test.app)
      .post(`/api/v1/teams/${TEAM_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({ userId: IVAN })
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});

describe('DELETE /api/v1/teams/{teamId}/members/{userId}', () => {
  /** Acceptance 2, the other direction. */
  it('removes the membership, bumps that person and files team.member_removed', async () => {
    const teams = seeded();

    await teams.addMember(TEAM_ID, IVAN, 'MEMBER');
    await teams.addMember(TEAM_ID, PETR, 'MEMBER');

    const { test, token } = await signedIn(admin(teams));

    await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}/members/${IVAN}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    expect(teams.versionBumps).toEqual([IVAN]);

    await expect(teams.detail(TEAM_ID)).resolves.toMatchObject({
      members: [{ userId: PETR }],
    });

    expect(test.audit.events.at(-1)).toMatchObject({
      action: 'team.member_removed',
      target: { type: 'TEAM', id: TEAM_ID },
      before: { userId: IVAN },
    });
  });

  /**
   * A membership that was not there is 404 — the honest answer. Reporting success would tell the
   * caller a state was reached that never existed.
   */
  it('answers 404 when the person is on no such team', async () => {
    const teams = seeded();
    const { test, token } = await signedIn(admin(teams));

    const response = await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}/members/${IVAN}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'user_not_found' });
    expect(teams.versionBumps).toEqual([]);
    expect(test.audit.events.filter((event) => event.action === 'team.member_removed')).toEqual([]);
  });

  /** Acceptance 7. */
  it('answers 404 for a team this organization cannot see', async () => {
    const { test, token } = await signedIn(admin());

    const response = await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}/members/${IVAN}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(response.body).toMatchObject({ code: 'team_not_found' });
  });

  /** Acceptance 8. */
  it('needs the capability', async () => {
    const { test, token } = await signedIn({ teams: seeded() });

    const response = await request(test.app)
      .delete(`/api/v1/teams/${TEAM_ID}/members/${IVAN}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    expect(response.body).toMatchObject({ reason: 'permission_not_granted' });
  });
});
