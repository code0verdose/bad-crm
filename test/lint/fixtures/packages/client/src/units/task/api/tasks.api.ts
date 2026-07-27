declare const useQuery: (options: unknown) => unknown;

export const listTasks = (): unknown => useQuery({ queryKey: ['tasks'] });
