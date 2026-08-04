import { describe, expect, it } from 'vitest';

import { AuthenticateSessionQuery } from '@/application/identity/use-cases/authenticate-session.query.js';
import { EndSessionUseCase } from '@/application/identity/use-cases/end-session.use-case.js';
import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import { ListSessionsQuery } from '@/application/identity/use-cases/list-sessions.query.js';
import { type LogFields } from '@/application/platform/ports/logger.port.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { type AppError } from '@/domain/shared/errors/app.errors.js';
import {
  FakeAccessTokens,
  FakeAddressHasher,
  FakeClock,
  FakeAuditLogger,
  FakeIdGenerator,
  FakeOrganizations,
  FakeRefreshTokens,
  FakeSessions,
  FakeUnitOfWork,
  ORGANIZATION_ID,
  RecordingLogger,
  USER_ID,
} from '../../support/identity-doubles.util.js';

const STRANGER = 'c0ffee00-0000-4000-8000-000000000009';
const ACTOR = { organizationId: ORGANIZATION_ID, userId: USER_ID };

const FIREFOX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

interface Harness {
  readonly clock: FakeClock;
  readonly sessions: FakeSessions;
  readonly issue: IssueSessionUseCase;
  readonly end: EndSessionUseCase;
  readonly list: ListSessionsQuery;
  readonly accessTokens: FakeAccessTokens;
  readonly authenticate: AuthenticateSessionQuery;
  readonly unitOfWork: FakeUnitOfWork;
  readonly logger: RecordingLogger;
  userStatus: string;
  permissionsVersion: number;
}

const harness = (): Harness => {
  const clock = new FakeClock();
  const state = { userStatus: 'ACTIVE', permissionsVersion: 1 };
  const sessions = new FakeSessions(clock, () => ({
    status: state.userStatus,
    permissionsVersion: state.permissionsVersion,
  }));
  const unitOfWork = new FakeUnitOfWork();
  const audit = new FakeAuditLogger();
  const accessTokens = new FakeAccessTokens();
  const logger = new RecordingLogger();

  const harnessed: Harness = {
    clock,
    sessions,
    unitOfWork,
    accessTokens,
    logger,
    issue: new IssueSessionUseCase(
      sessions,
      new FakeOrganizations(),
      new FakeRefreshTokens(),
      accessTokens,
      new FakeAddressHasher(),
      clock,
      new FakeIdGenerator(),
    ),
    end: new EndSessionUseCase(sessions, unitOfWork, clock, logger, audit),
    list: new ListSessionsQuery(sessions, unitOfWork, clock),
    authenticate: new AuthenticateSessionQuery(accessTokens, sessions, unitOfWork, clock),
    get userStatus() {
      return state.userStatus;
    },
    set userStatus(value: string) {
      state.userStatus = value;
    },
    get permissionsVersion() {
      return state.permissionsVersion;
    },
    set permissionsVersion(value: number) {
      state.permissionsVersion = value;
    },
  };

  return harnessed;
};

const signIn = (
  test: Harness,
  options: { userId?: string; userAgent?: string; ipAddress?: string } = {},
): Promise<{ sessionId: string; familyId: string; accessToken: string }> =>
  test.issue
    .execute({
      userId: options.userId ?? USER_ID,
      permissionsVersion: 1,
      client: {
        userAgent: options.userAgent ?? FIREFOX,
        ipAddress: options.ipAddress ?? '203.0.113.42',
      },
    })
    .then((issued) => ({
      sessionId: issued.sessionId,
      familyId: issued.familyId,
      accessToken: issued.accessToken,
    }));

const refusal = async (run: () => Promise<unknown>): Promise<AppError> => {
  try {
    await run();
  } catch (error) {
    return error as AppError;
  }

  throw new Error('expected a refusal');
};

describe('issuing a session', () => {
  /**
   * `uq_sessions_refresh_hash` is global, so a collision would be an answer about another
   * organization. The loop makes the only observable outcome the ordinary one.
   */
  it('mints another token when the digest was taken, and answers normally', async () => {
    const test = harness();

    test.sessions.collisionsToSimulate = 1;
    const issued = await signIn(test);

    expect(issued.sessionId).not.toBe('');
    expect(test.sessions.rows.size).toBe(1);
  });

  it('gives up as an internal error rather than as a conflict a client could read', async () => {
    const test = harness();

    test.sessions.collisionsToSimulate = 99;

    await expect(signIn(test)).rejects.toThrow(/could not mint/);
  });

  /**
   * The `org` claim is read back from the tenant root rather than passed in, so a scope naming an
   * organization that does not exist is a defect and not a session with an invented claim.
   */
  it('refuses when the scope names an organization that does not exist', async () => {
    const clock = new FakeClock();
    const sessions = new FakeSessions(clock);
    const organizations = new FakeOrganizations();

    organizations.forget();

    const issue = new IssueSessionUseCase(
      sessions,
      organizations,
      new FakeRefreshTokens(),
      new FakeAccessTokens(),
      new FakeAddressHasher(),
      clock,
      new FakeIdGenerator(),
    );

    await expect(
      issue.execute({
        userId: USER_ID,
        permissionsVersion: 1,
        client: { userAgent: FIREFOX, ipAddress: undefined },
      }),
    ).rejects.toThrow(/organization that does not exist/);
  });
});

describe('signing out', () => {
  it('revokes the whole family of the session it was called with', async () => {
    const test = harness();
    const first = await signIn(test);
    const rotated = await test.issue.execute({
      userId: USER_ID,
      permissionsVersion: 1,
      client: { userAgent: FIREFOX, ipAddress: '203.0.113.42' },
      familyId: first.familyId,
      rotatedFromId: first.sessionId,
    });

    await test.end.signOut(ACTOR, rotated.sessionId);

    expect([...test.sessions.rows.values()].every((row) => row.revokedAt !== null)).toBe(true);
    expect([...test.sessions.rows.values()][1]?.revokedReason).toBe('LOGOUT');
  });

  /** 204 either way, so the operation is idempotent by construction and needs no stored response. */
  it('does not complain about a session that is gone', async () => {
    const test = harness();

    await expect(test.end.signOut(ACTOR, 'session-does-not-exist')).resolves.toBeUndefined();
  });
});

describe('revoking one of my own sessions', () => {
  it('closes it and says whether it was the one I am using', async () => {
    const test = harness();
    const current = await signIn(test);
    const other = await signIn(test, { userAgent: CHROME_ANDROID });

    const result = await test.end.revoke(ACTOR, other.sessionId, current.sessionId);

    expect(result).toEqual({ wasCurrent: false });
    expect(test.sessions.rows.get(other.sessionId)?.revokedReason).toBe('REVOKED_BY_USER');
    expect(test.sessions.rows.get(current.sessionId)?.revokedAt).toBeNull();
  });

  it('reports the current one as current, so the caller knows to clear its cookie', async () => {
    const test = harness();
    const current = await signIn(test);

    await expect(test.end.revoke(ACTOR, current.sessionId, current.sessionId)).resolves.toEqual({
      wasCurrent: true,
    });
  });

  /**
   * Invariant 2 of CLAUDE.md over an enumerable id: a session of somebody else and an id that never
   * existed are the same 404, and neither is a 403.
   */
  it('answers 404 for a stranger and for a missing id alike, and changes nothing', async () => {
    const test = harness();
    const mine = await signIn(test);
    const theirs = await signIn(test, { userId: STRANGER });

    const stranger = await refusal(() => test.end.revoke(ACTOR, theirs.sessionId, mine.sessionId));
    const missing = await refusal(() => test.end.revoke(ACTOR, 'session-nope', mine.sessionId));

    expect(stranger.code).toBe('session_not_found');
    expect(stranger.status).toBe(404);
    expect(missing.code).toBe(stranger.code);
    expect(test.sessions.rows.get(theirs.sessionId)?.revokedAt).toBeNull();
  });

  it('opens the tenant scope of the caller, never of the row', async () => {
    const test = harness();
    const mine = await signIn(test);

    await test.end.revoke(ACTOR, mine.sessionId, mine.sessionId);

    expect(test.unitOfWork.scopes).toEqual([ACTOR]);
  });
});

describe('closing every other session', () => {
  it('leaves exactly the current one alive and counts the rest', async () => {
    const test = harness();
    const current = await signIn(test);

    await signIn(test, { userAgent: CHROME_ANDROID });
    await signIn(test, { userAgent: CHROME_ANDROID });

    await expect(test.end.revokeOthers(ACTOR, current.sessionId)).resolves.toBe(2);

    const live = [...test.sessions.rows.values()].filter((row) => row.revokedAt === null);

    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(current.sessionId);
  });

  it('answers zero on a repeat', async () => {
    const test = harness();
    const current = await signIn(test);

    await signIn(test, { userAgent: CHROME_ANDROID });
    await test.end.revokeOthers(ACTOR, current.sessionId);

    await expect(test.end.revokeOthers(ACTOR, current.sessionId)).resolves.toBe(0);
  });

  it('does not touch another person’s sessions', async () => {
    const test = harness();
    const current = await signIn(test);
    const theirs = await signIn(test, { userId: STRANGER });

    await test.end.revokeOthers(ACTOR, current.sessionId);

    expect(test.sessions.rows.get(theirs.sessionId)?.revokedAt).toBeNull();
  });

  it('refuses when the current session is not the caller’s', async () => {
    const test = harness();
    const theirs = await signIn(test, { userId: STRANGER });

    const error = await refusal(() => test.end.revokeOthers(ACTOR, theirs.sessionId));

    expect(error.code).toBe('session_not_found');
  });
});

describe('listing my sessions', () => {
  it('describes each device, marks the current one and hides the raw agent', async () => {
    const test = harness();
    const current = await signIn(test);

    test.clock.advance(60);
    await signIn(test, { userAgent: CHROME_ANDROID, ipAddress: '2001:db8:85a3::8a2e:370:7334' });

    const entries = await test.list.execute(ACTOR, current.sessionId);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      current: true,
      device: 'Firefox on macOS',
      ipMasked: '203.0.113.0/24',
    });
    expect(entries[1]).toMatchObject({
      current: false,
      device: 'Chrome on Android',
      ipMasked: '2001:db8:85a3::/48',
    });
    expect(JSON.stringify(entries)).not.toContain('AppleWebKit');
  });

  /**
   * The row's id changes on every rotation, so "current" has to be answered by family. Comparing
   * ids would unmark the caller's own device the moment a refresh happened.
   */
  it('still marks my device as current after it rotated', async () => {
    const test = harness();
    const first = await signIn(test);

    test.clock.advance(900);
    const rotated = await test.issue.execute({
      userId: USER_ID,
      permissionsVersion: 1,
      client: { userAgent: FIREFOX, ipAddress: '203.0.113.42' },
      familyId: first.familyId,
      rotatedFromId: first.sessionId,
    });

    await test.sessions.markRotated(first.sessionId, test.clock.now());

    const entries = await test.list.execute(ACTOR, rotated.sessionId);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.current).toBe(true);
  });

  it('dates the entry from the family, and the activity from the live row', async () => {
    const test = harness();
    const first = await signIn(test);
    const started = test.clock.now();

    test.clock.advance(3600);
    const rotated = await test.issue.execute({
      userId: USER_ID,
      permissionsVersion: 1,
      client: { userAgent: FIREFOX, ipAddress: '203.0.113.42' },
      familyId: first.familyId,
      rotatedFromId: first.sessionId,
    });

    await test.sessions.markRotated(first.sessionId, test.clock.now());

    const [entry] = await test.list.execute(ACTOR, rotated.sessionId);

    expect(entry?.createdAt).toEqual(started);
    expect(entry?.lastUsedAt).toEqual(test.clock.now());
  });

  it('leaves out revoked and expired sessions', async () => {
    const test = harness();
    const current = await signIn(test);
    const other = await signIn(test, { userAgent: CHROME_ANDROID });

    await test.sessions.revoke(other.sessionId, 'LOGOUT', test.clock.now());

    await expect(test.list.execute(ACTOR, current.sessionId)).resolves.toHaveLength(1);

    test.clock.advance(31 * 24 * 3600);
    await expect(test.list.execute(ACTOR, current.sessionId)).resolves.toEqual([]);
  });
});

describe('authenticating a request', () => {
  it('accepts a token whose session is still live', async () => {
    const test = harness();
    const session = await signIn(test);

    await expect(test.authenticate.execute(session.accessToken)).resolves.toEqual({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      sessionId: session.sessionId,
      familyId: session.familyId,
    });
  });

  it('refuses a token that does not verify', async () => {
    const test = harness();

    expect((await refusal(() => test.authenticate.execute('not-a-token'))).code).toBe(
      'unauthenticated',
    );
  });

  /**
   * The acceptance criterion of STORY-006-04: revocation takes effect on the *next* request, not at
   * the end of the access token's fifteen minutes.
   */
  it('refuses an unexpired token whose session was revoked', async () => {
    const test = harness();
    const session = await signIn(test);

    await test.end.signOut(ACTOR, session.sessionId);

    expect((await refusal(() => test.authenticate.execute(session.accessToken))).code).toBe(
      'unauthenticated',
    );
  });

  it('refuses a token whose session has expired', async () => {
    const test = harness();
    const session = await signIn(test);

    test.clock.advance(31 * 24 * 3600);

    expect((await refusal(() => test.authenticate.execute(session.accessToken))).code).toBe(
      'unauthenticated',
    );
  });

  it('refuses a token of an account that may no longer sign in', async () => {
    const test = harness();
    const session = await signIn(test);

    test.userStatus = 'SUSPENDED';

    expect((await refusal(() => test.authenticate.execute(session.accessToken))).code).toBe(
      'unauthenticated',
    );
  });

  /** What `pv` is for: rights change, and the token that predates the change stops being believed. */
  it('refuses a token minted before the permissions changed', async () => {
    const test = harness();
    const session = await signIn(test);

    test.permissionsVersion = 2;

    expect((await refusal(() => test.authenticate.execute(session.accessToken))).code).toBe(
      'unauthenticated',
    );
  });

  it('refuses a token naming a session this organization does not have', async () => {
    const test = harness();

    await signIn(test);
    test.accessTokens.issued.push({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      sessionId: 'session-elsewhere',
      permissionsVersion: 1,
    });

    expect((await refusal(() => test.authenticate.execute('access.session-elsewhere'))).code).toBe(
      'unauthenticated',
    );
  });

  /** A token whose `sub` is not the owner of the row it names — a forged or mismatched pairing. */
  it('refuses a token whose subject does not own the session it names', async () => {
    const test = harness();
    const session = await signIn(test, { userId: STRANGER });

    test.accessTokens.issued.push({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      sessionId: session.sessionId,
      permissionsVersion: 1,
    });

    expect(
      (await refusal(() => test.authenticate.execute(`access.${session.sessionId}`))).code,
    ).toBe('unauthenticated');
  });
});

/**
 * What closing a session writes down.
 *
 * Signing out, closing one device and closing every other device all revoke rows and, until now,
 * left nothing behind: the only trace was the error handler's line for the *failures*. That is the
 * wrong half — "who closed whose sessions, and when" is exactly the question an incident asks, and
 * the rows themselves are overwritten in place by the next revocation reason.
 */
describe('what closing a session records', () => {
  const revocations = (test: Harness): LogFields[] =>
    test.logger.lines
      .filter((line) => line.fields['event'] === SECURITY_EVENTS.sessionsRevoked)
      .map((line) => line.fields);

  it('records a sign-out with the actor, the session and the reason', async () => {
    const test = harness();
    const session = await signIn(test);

    await test.end.signOut(ACTOR, session.sessionId);

    expect(revocations(test)).toEqual([
      {
        event: SECURITY_EVENTS.sessionsRevoked,
        reason: 'LOGOUT',
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
        familyId: expect.any(String) as string,
        revokedFamilies: 1,
      },
    ]);
  });

  it('records closing another of one’s own devices', async () => {
    const test = harness();
    const other = await signIn(test);
    const current = await signIn(test);

    await test.end.revoke(ACTOR, other.sessionId, current.sessionId);

    expect(revocations(test)[0]).toMatchObject({ reason: 'REVOKED_BY_USER', revokedFamilies: 1 });
  });

  it('records how many devices “all other sessions” actually closed', async () => {
    const test = harness();

    await signIn(test);
    await signIn(test);
    const current = await signIn(test);

    await test.end.revokeOthers(ACTOR, current.sessionId);

    expect(revocations(test)[0]).toMatchObject({
      reason: 'REVOKED_BY_USER',
      revokedFamilies: 2,
    });
  });

  /** Signing out of a session that is already closed is a 204 and not an event. */
  it('records nothing when there was no live session to close', async () => {
    const test = harness();

    await test.end.signOut(ACTOR, 'c0ffee00-0000-4000-8000-000000000009');

    expect(revocations(test)).toEqual([]);
  });
});
