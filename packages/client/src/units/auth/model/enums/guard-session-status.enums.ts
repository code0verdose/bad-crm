/**
 * The session states a route guard makes a decision on.
 *
 * Declared here rather than imported from `units/session`, and the reason is the whole point of the
 * file: FSD dependencies point downwards only and units are independent of one another
 * (`rules/frontend-fsd.mdc` rule 1). `units/auth` reaching into `units/session` for its own argument
 * type would be the first unit-to-unit edge in the tree, and `test/architecture/layers.test.ts`
 * refuses it — correctly, because that edge is how two units become one.
 *
 * `unknown` is a real state and not a placeholder: between the first paint and the first answer of
 * the session endpoint the client genuinely does not know, and both guards let it through.
 *
 * The two vocabularies are kept identical by two mechanisms, one per direction of drift:
 *
 * - `tsc`, at the wiring. `app/routes/_authenticated.tsx` hands the guard the router context, whose
 *   `auth.status` is `SessionTypes.SessionState['status']`, and a parameter is checked
 *   contravariantly — a status added in `units/session` and not here is a compile error in the
 *   route file, which is exactly where someone must decide what the guard does about it.
 * - `test/routes/guards.test.ts`, at runtime. A test may import both units — an application file
 *   may not — and it asserts the two lists are the same one.
 */
export const GUARD_SESSION_STATUSES = ['unknown', 'anonymous', 'authenticated'] as const;

export type GuardSessionStatus = (typeof GUARD_SESSION_STATUSES)[number];
