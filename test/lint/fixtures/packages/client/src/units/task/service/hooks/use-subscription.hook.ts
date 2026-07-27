// `react` is not installed in the fixture tree, and resolving it is not what these fixtures are
// about: the rule matches the call, not the import it came from.
declare function useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;

export const useSubscription = (onOnline: () => void): void => {
  useEffect(() => {
    // A real side effect with the outside world: the browser owns the event, nothing derives it.
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [onOnline]);
};
