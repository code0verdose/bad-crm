import { refreshSession, type SessionRotation } from '@units/auth/lib';
import { type SessionIdentity, type SessionState } from '@units/auth/types';

/** One object per terminal state, so an unchanged state is an unchanged reference for `useSyncExternalStore`. */
const UNKNOWN: SessionState = { status: 'unknown' };
const ANONYMOUS: SessionState = { status: 'anonymous' };

export interface AuthSessionStore {
  /** The current state. Safe to call during render — it reads, it does not ask. */
  readonly read: () => SessionState;
  readonly subscribe: (listener: () => void) => () => void;
  /** The one `POST /auth/refresh` of this tab's life. Idempotent: later callers get the first answer. */
  readonly bootstrap: () => Promise<SessionState>;
  readonly start: (identity: SessionIdentity) => void;
  readonly end: () => void;
}

export interface AuthSessionStoreDeps {
  readonly refresh: () => Promise<SessionRotation>;
}

/**
 * Who this tab is, as a store outside React.
 *
 * **Outside React, and outside the query cache, on purpose.** The router reads this from
 * `beforeLoad`, which runs before any component and outside any render — a value that lived in
 * React state would reach a guard one commit late, and a guard that decides on last render's
 * session is a guard that sends a signed-in user to the login screen. Keeping it out of TanStack
 * Query is the other half: `queryClient.clear()` on sign-out would otherwise wipe the session state
 * and restart the very exchange the sign-out just ended (`rules/tanstack-query.mdc` §13).
 *
 * **`unknown` is the state this store exists to leave — but only on an answer.** Both guards let it
 * through, because between the first paint and the answer the client genuinely does not know and
 * guessing «anonymous» flashes a login form at everybody who reloads. `bootstrap()` resolves to
 * `anonymous` on a **refusal**; a rotation that never reached the server leaves the state untouched,
 * because «the server is unreachable» and «you are signed out» are different facts and only one of
 * them is knowable here.
 *
 * **`bootstrap()` is memoised for the life of the store once it has an answer**, which is what makes
 * it safe to call during render, lets the very first render already be waiting, and stops a
 * signed-out tab from asking again on the next render — a `POST /auth/refresh` from somebody who has
 * just deliberately left. An `unavailable` rotation releases the memo instead, so the tab can try
 * again without a page reload.
 *
 * A factory plus one module instance, like `createAppQueryClient`: the instance is the tab's single
 * session, and the factory is what lets a test have a store of its own instead of the tab's.
 */
export const createAuthSessionStore = ({ refresh }: AuthSessionStoreDeps): AuthSessionStore => {
  let state: SessionState = UNKNOWN;
  let bootstrapped: Promise<SessionState> | null = null;

  /**
   * A `Set`, so that a cleanup running twice — which is what `StrictMode` does to every effect —
   * cannot delete whichever listener had moved into the freed slot.
   */
  const listeners = new Set<() => void>();

  const set = (next: SessionState): SessionState => {
    state = next;
    // A copy: a listener that unsubscribes while being notified would otherwise mutate the set
    // mid-iteration.
    for (const listener of [...listeners]) listener();

    return next;
  };

  const signedIn = (identity: SessionIdentity): SessionState => ({
    status: 'authenticated',
    ...identity,
  });

  return {
    read: () => state,

    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    // Memoised per *answer about the session*, not per call — and `unavailable` is not one.
    //
    // A rotation that could not reach the server says nothing about whether this tab is signed in,
    // so it neither moves the state nor becomes the permanent answer: the memo is released and the
    // next caller asks again. Memoising it was a real incident in waiting — one restart of Postgres
    // during `docker compose up -d` and every open tab was `anonymous` until the page was reloaded
    // by hand, with a valid refresh cookie sitting in the browser the whole time.
    //
    // Staying `unknown` is the honest state and it is survivable: both guards let `unknown` through,
    // so the shell renders and its own queries surface the outage as an error, instead of a login
    // form that implies the session is gone. A rejection is treated the same way for the same
    // reason — nothing was learned — where it used to be folded into `anonymous`.
    bootstrap: () =>
      (bootstrapped ??= refresh().then(
        (rotation) => {
          if (rotation.kind === 'session') return set(signedIn(rotation.identity));
          if (rotation.kind === 'refused') return set(ANONYMOUS);

          bootstrapped = null;

          return state;
        },
        () => {
          bootstrapped = null;

          return state;
        },
      )),

    start: (identity) => {
      set(signedIn(identity));
    },

    end: () => {
      set(ANONYMOUS);
    },
  };
};

/** The session of this tab. */
export const authSession = createAuthSessionStore({ refresh: refreshSession });
