/**
 * Public surface of the `shared` layer: one namespace per segment, consumed as `SharedApi.…`.
 *
 * A segment is created when it has content; `test/architecture/structure.test.ts` fails on an empty
 * one, because an empty directory is a promise the tree cannot keep.
 */
export * as SharedApi from './api/index.js';
export * as SharedConfig from './config/index.js';
export * as SharedI18n from './i18n/index.js';
export * as SharedHooks from './hooks/index.js';
export * as SharedLib from './lib/index.js';
export * as SharedUi from './ui/index.js';
