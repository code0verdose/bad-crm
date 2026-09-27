/** How many recently visited projects the switcher pins — the contract's `recent` bound. */
export const RECENT_PROJECTS_MAX = 5;

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/**
 * What the browser remembered, made safe to use: an array of ids, nothing else, at most five, no
 * duplicates. Storage is outside the program — another tab of an older release, a hand edit, a
 * browser extension — so anything that is not that shape is dropped rather than trusted.
 */
export const sanitizeRecentProjectIds = (stored: unknown): string[] => {
  if (!Array.isArray(stored)) return [];

  const ids = stored.filter(
    (value): value is string => typeof value === 'string' && UUID.test(value),
  );

  return [...new Set(ids)].slice(0, RECENT_PROJECTS_MAX);
};

/** `projectId` moved to the front, the oldest dropped past the bound. */
export const withRecentProject = (ids: readonly string[], projectId: string): string[] =>
  [projectId, ...ids.filter((id) => id !== projectId)].slice(0, RECENT_PROJECTS_MAX);

/** `projectId` gone — the project was answered «not found», so it is not offered again. */
export const withoutRecentProject = (ids: readonly string[], projectId: string): string[] =>
  ids.filter((id) => id !== projectId);

/**
 * The recent list the switcher asks about: this tab's visits first (newest first), then what the
 * browser remembered from before, without the projects this tab was told are gone — deduplicated
 * and bounded. `remembered` is untrusted and is sanitized here.
 */
export const mergeRecentProjects = (
  visited: readonly string[],
  remembered: unknown,
  forgotten: readonly string[],
): string[] =>
  [...new Set([...visited, ...sanitizeRecentProjectIds(remembered)])]
    .filter((projectId) => !forgotten.includes(projectId))
    .slice(0, RECENT_PROJECTS_MAX);

/**
 * The server's answer to «which of these can I still open», put back in the order they were
 * visited. The server answers in name order; recency is the browser's to know.
 */
export const inRecencyOrder = <T extends { readonly id: string }>(
  options: readonly T[],
  ids: readonly string[],
): T[] =>
  ids.flatMap((id) => {
    const option = options.find((candidate) => candidate.id === id);

    return option === undefined ? [] : [option];
  });
