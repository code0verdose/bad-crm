/** The two fields of a project that name it — structural, so the card and an option both fit. */
export interface ProjectNaming {
  readonly key: string;
  readonly name: string;
}

/**
 * How a project names the page it is open on — «KEY · Name», in the tab, the trail and the heading
 * (STORY-014-06, acceptance 8). The same form as the switcher's trigger: the key leads, because it
 * is what tells two similarly named projects apart.
 *
 * Not a translation: the key and the name are the project's own words, and the middle dot is a
 * separator every language here reads the same.
 */
export const projectTitle = ({ key, name }: ProjectNaming): string => `${key} · ${name}`;
