/**
 * What the session can announce to the rest of the application.
 *
 * A closed vocabulary rather than free strings: the subscriber is `app/`, which turns `logged-out`
 * into a redirect to `/login?redirect=…`, and a typo in an event name would be a redirect that
 * silently never happens.
 *
 * `refresh-failed` and `logged-out` are two different moments and both are needed: the first says
 * the rotation was refused (worth a log line and, later, a telemetry counter), the second says the
 * tab now has no session at all (worth a navigation). `logged-in` has no producer until the sign-in
 * flow lands with EPIC-006; it is listed because the vocabulary is the contract, not the inventory
 * of what happens to emit today.
 */
export const AUTH_EVENTS = ['logged-in', 'logged-out', 'refresh-failed'] as const;

export type AuthEvent = (typeof AUTH_EVENTS)[number];
