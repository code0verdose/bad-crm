declare function useEffect(effect: () => void, deps: readonly unknown[]): void;
declare function useState<T>(initial: T): [T, (next: T) => void];

export const useDerivedState = (tasks: readonly string[]): number => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(tasks.length);
  }, [tasks]);

  return count;
};
