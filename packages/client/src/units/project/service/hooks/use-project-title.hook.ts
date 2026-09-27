import { projectTitle } from '@units/project/lib';
import { useCurrentProjectQuery } from '@units/project/service/queries/project-options.query.js';

/**
 * What the page of an open project is called — «KEY · Name» — or `null` outside a project and
 * before its card is in the cache (STORY-014-06, acceptance 8).
 *
 * **Read from the cache, never fetched**, through the same disabled query the switcher's trigger
 * reads: the project layout's guard is what asks for the card, after deciding the reader may see
 * it. Subscribed, so a rename that lands in the cache renames the tab and the trail as well.
 */
export const useProjectTitle = (projectId: string | null): string | null => {
  const { data } = useCurrentProjectQuery(projectId);

  return projectId === null || data === undefined ? null : projectTitle(data);
};
