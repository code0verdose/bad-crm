declare function useEffect(effect: () => void, deps: readonly unknown[]): void;

export const useUnjustifiedEffect = (title: string): void => {
  useEffect(() => {
    document.title = title;
  }, [title]);
};
