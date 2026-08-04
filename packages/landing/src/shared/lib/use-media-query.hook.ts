import { useCallback, useSyncExternalStore } from 'react';

/**
 * A media query as an external store. Same shape as `use-reduced-motion.hook.ts`, and same reason:
 * the first render already knows the answer, so nothing renders for the wrong viewport and swaps.
 *
 * The server snapshot is `false` — in the runner's jsdom nothing matches, and a component that
 * mounts a WebGL canvas because it believed it was on a wide screen would fail there loudly.
 */
export const useMediaQuery = (query: string): boolean => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = globalThis.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia(query).matches,
    () => false,
  );
};
