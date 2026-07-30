/**
 * What this tab knows about the current sign-in — the vocabulary the store holds, the guards branch
 * on and the shell renders.
 *
 * One list, in one unit. It used to be two — `SESSION_STATUSES` in `units/session` and
 * `GUARD_SESSION_STATUSES` here — because a unit may not import another unit and the guards needed
 * a vocabulary of their own. The glossary always described that split as temporary
 * (`docs/product/glossary.md`, «Сессия (клиентская)»): the mechanics and the state are one concern,
 * and EPIC-006 is where they become one unit. Two lists kept identical by a test is a test that
 * exists only because of a split nobody wanted.
 *
 * `unknown` is a real state and not a placeholder: between the first paint and the answer of
 * `POST /auth/refresh` the client genuinely does not know. Rendering `anonymous` during that window
 * flashes a login screen at a signed-in user on every reload; both guards therefore let it through,
 * and the shell shows a neutral loading screen rather than a route.
 */
export const SESSION_STATUSES = ['unknown', 'anonymous', 'authenticated'] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Translation keys, never text. The catalogue itself lands with i18next (ADR-0019); what belongs
 * to the unit is the mapping from its own union to the key, so a new status cannot be added
 * without someone noticing that it has no label.
 */
export const SESSION_STATUS_LABEL_KEY: Record<SessionStatus, string> = {
  unknown: 'auth.session.status.unknown',
  anonymous: 'auth.session.status.anonymous',
  authenticated: 'auth.session.status.authenticated',
};
