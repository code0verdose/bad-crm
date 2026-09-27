/**
 * The sections of a project card, in the order the tab list shows them (STORY-014-05, acceptance 1).
 *
 * `available: false` is a section **declared and not yet shipped**: it is drawn as a disabled tab
 * with a «coming» mark, so the card has its final shape now and a later milestone switches a flag
 * instead of reshaping the screen. A disabled tab has no route behind it and no link, which is what
 * keeps it from leading to a 404.
 *
 * Overview, members (STORY-014-02) and settings (STORY-014-01) are shipped; files are EPIC-015;
 * boards, documents and time are M3+. Settings is shipped but **not always shown**: a reader the
 * card's `permissions` block gives no settings command, and who does not hold the capability
 * `project:manage_visibility`, does not see the tab at all (STORY-014-05, acceptance 5). The
 * capability half is temporary — the block has no visibility flag yet. The tab list takes the
 * hidden sections from its caller (`pages/project/hooks/use-project-section.hook.ts`).
 */
export const PROJECT_SECTIONS = [
  { value: 'overview', labelKey: 'projects.section.overview', available: true },
  { value: 'members', labelKey: 'projects.section.members', available: true },
  { value: 'files', labelKey: 'projects.section.files', available: false },
  { value: 'boards', labelKey: 'projects.section.boards', available: false },
  { value: 'docs', labelKey: 'projects.section.docs', available: false },
  { value: 'time', labelKey: 'projects.section.time', available: false },
  { value: 'settings', labelKey: 'projects.section.settings', available: true },
] as const;

export type ProjectSection = (typeof PROJECT_SECTIONS)[number]['value'];

/**
 * The blocks of the overview that belong to domains not built yet — shown as «arrives in a later
 * release» rather than as an empty chart (acceptance 4).
 */
export const PROJECT_UPCOMING_BLOCKS = [
  { value: 'activity', titleKey: 'projects.upcoming.activity' },
  { value: 'tasks', titleKey: 'projects.upcoming.tasks' },
  { value: 'time', titleKey: 'projects.upcoming.time' },
  { value: 'ci', titleKey: 'projects.upcoming.ci' },
] as const;
