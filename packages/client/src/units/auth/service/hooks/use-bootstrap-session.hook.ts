import { useSyncExternalStore } from 'react';

import { authSession } from '@units/auth/service/stores';
import { type SessionState } from '@units/auth/types';

/**
 * What the shell renders from, and the thing that makes `unknown` temporary.
 *
 * Two responsibilities, and they belong together: it makes sure the one `POST /auth/refresh` of
 * this tab has been started, and it re-renders whoever reads it when the answer lands. Split apart,
 * the reader could mount without the exchange ever being started — which is the failure this story
 * exists to close, and the failure with no symptom: guards let `unknown` through on purpose, so the
 * application would simply wait for ever.
 *
 * `useSyncExternalStore` rather than state plus an effect, because the store is read from outside
 * React too: `beforeLoad` asks it before any component renders (`app/router-auth.util.ts`), and
 * a value that lived in React state would reach a guard one commit late.
 *
 * The call to `bootstrap()` during render is deliberate and is not the `useEffect` that
 * `rules/frontend-fsd.mdc` rule 11 forbids — it is the opposite of it. `bootstrap()` is memoised
 * for the life of the store, so the second, third and hundredth render observe the promise the
 * first one made, `StrictMode`'s extra render included, and it changes nothing synchronously.
 * Starting it here rather than from an effect is what lets the first paint already be waiting for
 * the answer instead of starting to wait one commit later; there is nothing to clean up, because
 * there is nothing to undo.
 */
export const useBootstrapSession = (): SessionState => {
  void authSession.bootstrap();

  return useSyncExternalStore(authSession.subscribe, authSession.read, authSession.read);
};
