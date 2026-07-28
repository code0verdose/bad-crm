import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { IS_DEV_SERVER } from '@shared/config';

/**
 * The TanStack Query devtools panel in a dev-server build, and `null` in every other one.
 *
 * The condition is a **build-time** one, not a feature flag, and that distinction is the whole
 * point of the file. `IS_DEV_SERVER` is substituted by Vite with a literal before Rolldown sees
 * this module, so a production build contains `false ? ReactQueryDevtools : null`: the binding is
 * dead, the package is marked `sideEffects: false`, and the import is removed with everything
 * behind it. A panel hidden behind a runtime `if` would instead be downloaded and parsed by every
 * user in order to decide not to show it.
 *
 * A **static** import rather than `lazy(() => import(…))`, which is the usual advice and was tried
 * first: with the dynamic form Rolldown eliminated the call site correctly — no chunk referenced it
 * — but still emitted the split chunk as an orphan, 0.15 kB of `dist/assets/*.js` that
 * `.size-limit.js` counts as initial JS and that nothing would ever fetch. Measured both ways:
 * initial JS is 184.95 kB gzipped with the static import and 185.10 kB with the lazy one, against a
 * 184.97 kB baseline before the devtools existed. Tree-shaking a dead binding removes the code; a
 * dynamic import only makes it unreachable.
 *
 * A module of its own rather than three lines in `providers.tsx`, because the switch is the thing
 * worth testing on both settings, and `test/app/query-devtools.test.tsx` can only observe a module
 * evaluating its condition by importing it afresh behind a mock.
 */
export const QueryDevtools = IS_DEV_SERVER ? ReactQueryDevtools : null;
