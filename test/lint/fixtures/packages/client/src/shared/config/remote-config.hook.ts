declare const useQuery: (options: { queryKey: string[] }) => { data?: unknown };

export const useRemoteConfig = (): unknown => useQuery({ queryKey: ['config'] }).data;
