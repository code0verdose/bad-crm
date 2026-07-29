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
 * Absent on purpose: `service/queries`. Restoring a session is a rotation — one `POST /auth/refresh`
 * per tab, deduplicated, with a credential in the answer — and a cache entry is exactly what it must
 * not become (CLAUDE.md, invariant 3). It lives in `service/stores` instead.
 */
export * as AuthApi from './api/index.js';
export * as AuthLib from './lib/index.js';
export * as AuthModel from './model/index.js';
export * as AuthService from './service/index.js';
export type * as AuthTypes from './types/index.js';
export * as AuthUi from './ui/index.js';
