/**
 * Route guards of the auth unit — the canonical home `ux-architecture.md` → «Карта маршрутов»
 * gives them. They are pure functions over the two fields of `beforeLoad` they read, so the routing
 * layer stays wiring and the session decision stays in the unit that owns the session.
 */
export * from './guard-args.types.js';
export * from './redirect-if-authed.guard.js';
export * from './require-session.guard.js';
