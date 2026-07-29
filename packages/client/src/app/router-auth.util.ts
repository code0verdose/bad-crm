import { AuthService } from '@units/auth';

import { type RouterAuthState } from './router-context.types.js';

/**
 * The session as the router reads it: a live view, not a snapshot.
 *
 * A getter rather than a value, and that is the whole point of the file. `beforeLoad` runs outside
 * React — before any component renders, on every navigation and on every `router.invalidate()` —
 * and the router context is an object it closes over, built once. Handed a plain `{ status }`, a
 * guard would keep deciding on whatever the session was when the object was made, and the fix
 * people reach for (passing a fresh context on every render through `RouterProvider`) is worse: it
 * ties «what the guard sees» to React's commit schedule, so the first navigation after a sign-in
 * decides on the previous state.
 *
 * Reading the store on each access removes the question. `authSession.read()` is synchronous and
 * allocates nothing, the guards get today's answer, and the only thing that has to be remembered is
 * to re-run them — which `app/auth-events.util.ts` does on the two events that change the answer.
 */
export const routerAuth: RouterAuthState = {
  get status() {
    return AuthService.authSession.read().status;
  },
};
