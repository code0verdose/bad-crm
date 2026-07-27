/**
 * Public API of @bad-crm/shared — isomorphic code shared by the server and the client.
 *
 * Nothing here may touch Node-only or browser-only APIs; the boundary is enforced by
 * `test/config/isomorphic.test.ts` and by a tsconfig without `DOM` and without `@types/node`.
 *
 * Each segment is exposed as one namespace, so a call site reads as
 * `SharedValidation.emailSchema` and it is obvious which layer a symbol came from. Segments are
 * also reachable as subpaths (`@bad-crm/shared/permissions`) for consumers that want exactly one.
 */
export * as SharedValidation from './validation/index.js';
export * as SharedPermissions from './permissions/index.js';
export * as SharedErrors from './errors/index.js';
export * as SharedResult from './result/index.js';

/** Branded ids are types only — they carry no runtime value to put behind a namespace. */
export type * from './types/index.js';

/** Workspace name of this package; imported by server and client as a wiring smoke check. */
export const SHARED_PACKAGE_NAME = '@bad-crm/shared';
