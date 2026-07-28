/**
 * Public surface of the auth unit: the session credential of this tab and the transport binding
 * built on it.
 *
 * Segments absent on purpose. There is no `api` here — the one request this unit needs
 * (`POST /auth/refresh`) is a raw call that may only live in `shared/api`, and the operations that
 * would fill this segment are not in `docs/api/openapi.yaml` yet; they arrive with EPIC-006, and so
 * do `service`, `ui` and the sign-in form. An empty segment created "for later" is what
 * `test/architecture/structure.test.ts` rejects — the directory is the claim that something is there.
 */
export * as AuthLib from './lib/index.js';
export * as AuthModel from './model/index.js';
