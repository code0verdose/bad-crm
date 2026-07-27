/**
 * Public surface of the session unit — the template every later unit is copied from.
 *
 * Each segment is exposed as one namespace, so a call site reads `SessionService.useSessionStatus()`
 * and it is obvious which segment a symbol came from. Nothing inside is importable from outside the
 * unit: `bad-crm/no-foreign-unit-internals` in `eslint.config.js` refuses `@units/session/service`
 * from anywhere but this unit, and `test/architecture/barrels.test.ts` proves the barrel still
 * covers every segment that exists.
 *
 * Segments absent on purpose: `api` and `service/{queries,mutations}` arrive with the typed API
 * client (STORY-004-06), `model/validation` with the first schema, `service/stores` if a unit ever
 * needs one. An empty segment created "for later" is what `test/architecture/structure.test.ts`
 * rejects — the directory is the claim that something is there.
 */
export * as SessionModel from './model/index.js';
export * as SessionService from './service/index.js';
export type * as SessionTypes from './types/index.js';
export * as SessionUi from './ui/index.js';
