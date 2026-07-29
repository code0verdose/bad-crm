import { describe, expect, it, vi } from 'vitest';

import { type AuthTypes } from '@units/auth';
import { createAuthSessionStore } from '@units/auth/service';

/**
 * The state machine behind every guard in the tree: `unknown` → `authenticated` | `anonymous`.
 *
 * **`unknown` has to stop being `unknown` — on an answer.** Both guards let it through on purpose:
 * the client genuinely does not know yet, and treating that as «anonymous» bounces a signed-in user
 * to the login screen on every reload.
 *
 * The distinction the cases below turn on is what counts as an answer. A session and a refusal are
 * answers and both leave `unknown` for good. A rotation that never reached the server is not: it
 * stays `unknown` and releases the memo so the tab can ask again, because «the server is unreachable»
 * and «you are signed out» are different facts and only the second one belongs in the state. The
 * cost of that choice is bounded — guards pass, the shell renders, and the queries behind it surface
 * the outage as a retryable error — while the cost of guessing «anonymous» is every open tab landing
 * on a login form during a routine restart.
 *
 * Tested through the factory rather than through the module instance, so each case gets a store of
 * its own — a singleton would carry the first case's answer into the second.
 */
const IDENTITY: AuthTypes.SessionIdentity = {
  userId: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  organizationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
} as AuthTypes.SessionIdentity;

/** `null` stands for a refusal — the server saying this cookie is finished. */
const storeThatFinds = (identity: AuthTypes.SessionIdentity | null) =>
  createAuthSessionStore({
    refresh: () =>
      Promise.resolve(
        identity === null ? { kind: 'refused' as const } : { kind: 'session' as const, identity },
      ),
  });

/** A rotation that never reached the server: an outage, not an answer about the session. */
const storeThatCannotReachTheServer = () =>
  createAuthSessionStore({ refresh: () => Promise.resolve({ kind: 'unavailable' as const }) });

describe('the session store before anything has been asked', () => {
  it('says it does not know, rather than guessing that nobody is signed in', () => {
    expect(storeThatFinds(null).read()).toEqual({ status: 'unknown' });
  });
});

describe('the bootstrap exchange', () => {
  it('turns a live refresh cookie into a signed-in session', async () => {
    const store = storeThatFinds(IDENTITY);

    await store.bootstrap();

    expect(store.read()).toEqual({ status: 'authenticated', ...IDENTITY });
  });

  it('turns a refused refresh into an anonymous one, not into a permanent unknown', async () => {
    const store = storeThatFinds(null);

    await store.bootstrap();

    expect(store.read()).toEqual({ status: 'anonymous' });
  });

  /**
   * An outage is not a sign-out, and this pair of assertions is the whole reason the rotation now
   * reports three outcomes instead of two.
   *
   * `anonymous` is a claim about the person: it says «you are not signed in», and the guards act on
   * it by sending the tab to the login form. A `5xx` or a dropped connection supports no such claim —
   * the refresh cookie in the browser may be perfectly good. Writing `anonymous` on an outage was a
   * queued incident: one restart of Postgres during `docker compose up -d` and every open tab landed
   * on the login form, which is exactly the failure the server side of this epic was changed to
   * prevent by answering `5xx` instead of `401`.
   *
   * Staying `unknown` is survivable in a way `anonymous` is not: both guards let `unknown` through,
   * so the shell renders and its own queries surface the outage as an error the user can retry.
   */
  it('stays unknown when the rotation could not reach the server', async () => {
    const store = storeThatCannotReachTheServer();

    await store.bootstrap();

    expect(store.read()).toEqual({ status: 'unknown' });
  });

  it('stays unknown when the exchange rejects outright', async () => {
    const store = createAuthSessionStore({
      refresh: () => Promise.reject(new Error('the network is gone')),
    });

    await store.bootstrap();

    expect(store.read()).toEqual({ status: 'unknown' });
  });

  /**
   * And it must be able to try again without a page reload — the memo is what made the old behaviour
   * permanent. `bootstrap()` is memoised on an *answer*; an outage releases it.
   */
  it('asks again after an outage, instead of answering from the memo for ever', async () => {
    let outcome:
      { kind: 'unavailable' } | { kind: 'session'; identity: AuthTypes.SessionIdentity } = {
      kind: 'unavailable',
    };
    const refresh = vi.fn(() => Promise.resolve(outcome));
    const store = createAuthSessionStore({ refresh });

    await store.bootstrap();
    expect(store.read()).toEqual({ status: 'unknown' });

    outcome = { kind: 'session', identity: IDENTITY };
    await store.bootstrap();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(store.read()).toEqual({ status: 'authenticated', ...IDENTITY });
  });

  it('exchanges once however many times it is asked, including after it has answered', async () => {
    const refresh = vi.fn(() => Promise.resolve({ kind: 'session' as const, identity: IDENTITY }));
    const store = createAuthSessionStore({ refresh });

    await Promise.all([store.bootstrap(), store.bootstrap()]);
    await store.bootstrap();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  /**
   * A sign-out is final until somebody signs in again. Without the memo, the hook that starts the
   * bootstrap would start a new one on the next render — a `POST /auth/refresh` from a tab that has
   * just deliberately ended its session.
   */
  it('does not start again after a sign-out', async () => {
    const refresh = vi.fn(() => Promise.resolve({ kind: 'session' as const, identity: IDENTITY }));
    const store = createAuthSessionStore({ refresh });

    await store.bootstrap();
    store.end();
    await store.bootstrap();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.read()).toEqual({ status: 'anonymous' });
  });
});

describe('the transitions a sign-in and a sign-out make', () => {
  it('records who signed in', () => {
    const store = storeThatFinds(null);

    store.start(IDENTITY);

    expect(store.read()).toEqual({ status: 'authenticated', ...IDENTITY });
  });

  it('forgets who it was after a sign-out', () => {
    const store = storeThatFinds(null);
    store.start(IDENTITY);

    store.end();

    expect(store.read()).toEqual({ status: 'anonymous' });
  });
});

describe('subscribers', () => {
  it('are told about every transition', async () => {
    const store = storeThatFinds(IDENTITY);
    const listener = vi.fn();
    store.subscribe(listener);

    await store.bootstrap();
    store.end();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stop being told once they unsubscribe', () => {
    const store = storeThatFinds(null);
    const listener = vi.fn();

    store.subscribe(listener)();
    store.start(IDENTITY);

    expect(listener).not.toHaveBeenCalled();
  });

  /**
   * A `Set`, so that a cleanup running twice — which is what `StrictMode` does to every effect —
   * cannot delete whichever listener moved into the freed slot.
   */
  it('survive a double unsubscribe without silencing anybody else', () => {
    const store = storeThatFinds(null);
    const kept = vi.fn();
    store.subscribe(kept);
    const unsubscribeGone = store.subscribe(vi.fn());

    unsubscribeGone();
    unsubscribeGone();
    store.start(IDENTITY);

    expect(kept).toHaveBeenCalledTimes(1);
  });
});
