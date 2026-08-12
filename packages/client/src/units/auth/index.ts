/**
 * Public surface of the auth unit: the session of this tab, the transport binding built on it, the
 * guards that read it and the form that creates it.
 *
 * It absorbed `units/session` in EPIC-006, which is what the glossary always said would happen
 * («Временное разделение: механика живёт в `units/auth`, состояние — здесь; в EPIC-006 … они
 * объединяются в `units/auth`»). Splitting the state of a session from the mechanics of one meant
 * two vocabularies of the same three words, kept identical by a test, and a store that could not
 * see the token it belonged to.
 *
 * `service/queries` holds exactly one read, and the rule that kept the segment empty until
 * EPIC-013 still stands: **an answer that carries a credential is never a query.** Restoring a
 * session is a rotation — one `POST /auth/refresh` per tab, deduplicated, with a token in the
 * answer — and it lives in `service/stores`; the drafted TOTP secret and the ten recovery codes are
 * answers to mutations for the same reason, with `gcTime: 0` on top. What the segment does hold is
 * `GET /auth/2fa/recovery-codes`, which answers `{ total, remaining }` and cannot be made to say
 * anything else — a counter is cacheable precisely because it is not a credential.
 */
export * as AuthApi from './api/index.js';
export * as AuthLib from './lib/index.js';
export * as AuthModel from './model/index.js';
export * as AuthService from './service/index.js';
export type * as AuthTypes from './types/index.js';
export * as AuthUi from './ui/index.js';
