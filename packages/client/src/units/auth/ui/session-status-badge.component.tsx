import { SESSION_STATUS_LABEL_KEY, type SessionStatus } from '@units/auth/model';

export interface SessionStatusBadgeProps {
  readonly status: SessionStatus;
}

/**
 * Shows the state of the session. Markup and one prop — the state itself is decided by
 * `useBootstrapSession`, one layer down.
 *
 * The text is the translation *key*, not a sentence: the i18next catalogue arrives with ADR-0019,
 * and until it does, a visible `session.status.unknown` is a key nobody can forget to translate.
 * `data-session-status` is what a test and a future stylesheet key off, so neither depends on the
 * text.
 */
export function SessionStatusBadge({ status }: SessionStatusBadgeProps) {
  return <span data-session-status={status}>{SESSION_STATUS_LABEL_KEY[status]}</span>;
}
