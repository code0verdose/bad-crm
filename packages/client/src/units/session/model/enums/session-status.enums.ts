/**
 * What the client knows about the browser session.
 *
 * `unknown` is a real state, not a placeholder: between the first paint and the first answer from
 * the session endpoint the client genuinely does not know, and a UI that renders `anonymous`
 * during that window flashes a login screen at a signed-in user on every reload.
 */
export const SESSION_STATUSES = ['unknown', 'anonymous', 'authenticated'] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Translation keys, never text. The catalogue itself lands with i18next (ADR-0019); what belongs
 * to the unit is the mapping from its own union to the key, so a new status cannot be added
 * without someone noticing that it has no label.
 */
export const SESSION_STATUS_LABEL_KEY: Record<SessionStatus, string> = {
  unknown: 'session.status.unknown',
  anonymous: 'session.status.anonymous',
  authenticated: 'session.status.authenticated',
};
