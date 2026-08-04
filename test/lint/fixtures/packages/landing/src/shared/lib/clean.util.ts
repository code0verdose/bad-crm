/**
 * The positive control for the two landing bans: `globalThis` used for the things the package is
 * allowed to use it for. Without it, a ban wide enough to forbid reading the current path would
 * read as correct here while making the router impossible to write.
 */
export const currentPath = (): string => globalThis.location.pathname;

export const later = (run: () => void): void => {
  globalThis.setTimeout(run, 16);
};
