/**
 * Public surface of the `shared` layer: one namespace per segment, consumed as `SharedApi.…`.
 *
 * `ui` and `hooks` are not here yet, and their directories do not exist either — the design system
 * lands with Mantine (EPIC-007). A segment is created when it has content;
 * `test/architecture/structure.test.ts` fails on an empty one, because an empty directory is a
 * promise the tree cannot keep.
 */
export * as SharedApi from './api/index.js';
export * as SharedConfig from './config/index.js';
export * as SharedLib from './lib/index.js';
