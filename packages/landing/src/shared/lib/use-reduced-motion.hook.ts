import { useCallback, useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The JavaScript half of the motion kill switch (`global.css` holds the CSS half).
 *
 * `useSyncExternalStore` rather than `useEffect` + `useState`: the preference is an external store,
 * React has a hook for exactly that, and this way the first render already knows the answer instead
 * of animating for one frame and then stopping.
 *
 * The subscription is live. Somebody flipping the system setting while the page is open gets a
 * static page immediately — which is the reading of the setting that matters to a person who turned
 * it on because the page made them ill.
 */
export const useReducedMotion = (): boolean => {
  const subscribe = useCallback((onChange: () => void) => {
    const media = globalThis.matchMedia(QUERY);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia(QUERY).matches,
    // Server snapshot: there is no SSR here, but the runner renders in jsdom where the media query
    // is undefined unless a test stubs it. Reduced by default is the safe answer.
    () => true,
  );
};
