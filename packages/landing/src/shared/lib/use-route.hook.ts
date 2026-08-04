import { useCallback, useSyncExternalStore } from 'react';

/** The paths the landing serves. Anything else falls back to the landing itself. */
export const ROUTES = {
  home: '/',
  terms: '/terms',
  privacy: '/privacy',
  cookies: '/cookies',
} as const;

export type Route = (typeof ROUTES)[keyof typeof ROUTES];

/**
 * The current path, as an external store.
 *
 * Four static pages do not need a router: this is `location.pathname` plus a subscription to the
 * two events that can change it. A dependency that ships a matcher, a link component and a history
 * abstraction would be larger than every page it serves.
 *
 * Static hosting needs the usual SPA rewrite — any unknown path serves `index.html` — which the
 * Vite dev server does out of the box and `packages/landing/README.md` documents for deployment.
 */
export const useRoute = (): Route => {
  const subscribe = useCallback((onChange: () => void) => {
    globalThis.addEventListener('popstate', onChange);
    globalThis.addEventListener('bcl:navigate', onChange);
    return () => {
      globalThis.removeEventListener('popstate', onChange);
      globalThis.removeEventListener('bcl:navigate', onChange);
    };
  }, []);

  const path = useSyncExternalStore(
    subscribe,
    () => globalThis.location.pathname,
    () => ROUTES.home,
  );

  return (Object.values(ROUTES) as string[]).includes(path) ? (path as Route) : ROUTES.home;
};

/**
 * Client-side navigation.
 *
 * `pushState` does not fire `popstate` — that is what the custom event is for. Called from the
 * `onClick` of a real `<a href>`, so middle-click, right-click and “open in new tab” keep working.
 */
export const navigate = (route: Route): void => {
  globalThis.history.pushState(null, '', route);
  globalThis.dispatchEvent(new Event('bcl:navigate'));
  globalThis.scrollTo({ top: 0 });
};
