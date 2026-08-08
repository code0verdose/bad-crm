import { createStore, type StoreApi } from 'zustand/vanilla';

import { refreshSession, type SessionRotation } from '@units/auth/lib';
import { type SessionIdentity, type SessionState } from '@units/auth/types';

/** One object per terminal state, so an unchanged state is an unchanged reference for subscribers. */
const UNKNOWN: SessionState = { status: 'unknown' };
const ANONYMOUS: SessionState = { status: 'anonymous' };

/** Everything the store holds. One field: the state machine every guard in the tree reads. */
export interface AuthSessionState {
  readonly session: SessionState;
}

/**
 * The store plus the four operations on it.
 *
 * The operations are **not** in the state, which is the one place this deviates from the shape most
 * zustand examples show. Actions in the state are convenient inside React — one `useStore` gives a
 * component both the value and the way to change it — but this store's main reader is a router guard
 * that never renders, and `subscribe` fires for every field of the state. Keeping the state to the
 * one thing that changes means a subscriber is woken by a session change and by nothing else.
 */
export interface AuthSessionStore extends StoreApi<AuthSessionState> {
  /** The current state. Safe to call during render and from `beforeLoad` — it reads, it does not ask. */
  readonly read: () => SessionState;
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
 * **`createStore` from `zustand/vanilla`, not `create`** (ADR-0026, rule 16 of
 * `rules/frontend-fsd.mdc`): `create` returns a hook, and a hook cannot be called from a guard. The
 * vanilla store is a plain object with `getState`/`setState`/`subscribe`, and `useStore` in
 * `use-bootstrap-session.hook.ts` is what turns it into a subscription for components. The `Set` of
 * listeners and the notification loop this file used to carry are now the library's — together with
 * the case they existed for, where `StrictMode` runs a cleanup twice.
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
  const store = createStore<AuthSessionState>(() => ({ session: UNKNOWN }));

  /**
   * Outside the state, deliberately: a promise is not something anybody renders, and replacing it
   * in the state would wake every subscriber for a change none of them can see.
   */
  let bootstrapped: Promise<SessionState> | null = null;

  const read = (): SessionState => store.getState().session;

  const settle = (next: SessionState): SessionState => {
    store.setState({ session: next });

    return next;
  };

  return Object.assign(store, {
    read,

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
    // reason — nothing was learned.
    bootstrap: (): Promise<SessionState> =>
      (bootstrapped ??= refresh().then(
        (rotation) => {
          if (rotation.kind === 'session') {
            return settle({ status: 'authenticated', ...rotation.identity });
          }
          if (rotation.kind === 'refused') return settle(ANONYMOUS);

          bootstrapped = null;

          return read();
        },
        () => {
          bootstrapped = null;

          return read();
        },
      )),

    start: (identity: SessionIdentity): void => {
      settle({ status: 'authenticated', ...identity });
    },

    end: (): void => {
      settle(ANONYMOUS);
    },
  });
};

/** The session of this tab. */
export const authSession = createAuthSessionStore({ refresh: refreshSession });
