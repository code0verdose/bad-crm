import { type SessionState } from '@units/session/types';

/**
 * The unit's public surface for the UI: one hook that returns state ready to render.
 *
 * It answers `unknown` because that is the truth today — the session endpoint and the typed API
 * client arrive with STORY-004-06, and nothing has been asked yet. When they do, the query moves
 * into `service/queries` and this hook composes it; every caller keeps the same import and the
 * same shape, which is the whole point of the call chain `ui → service/hooks → service/queries`.
 */
/** One object, not one per render: an unstable identity would invalidate every consumer's memo. */
const UNKNOWN_SESSION: SessionState = { status: 'unknown' };

export const useSessionStatus = (): SessionState => UNKNOWN_SESSION;
