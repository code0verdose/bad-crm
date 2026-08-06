import { type NavSection } from '@widgets/app-shell';

/**
 * The menu, minus the entries this person cannot open.
 *
 * A **hint**, not a gate — every route behind these links has its own guard and every request is
 * authorised again on the server. What it buys is an interface without dead ends: a link that
 * answers «not found» teaches people to distrust the menu (`ux-architecture.md`, principle 6).
 *
 * A section that loses all of its items disappears with them, rather than leaving a heading over
 * nothing.
 */
export const visibleSections = (
  sections: readonly NavSection[],
  can: (permission: string) => boolean,
): readonly NavSection[] =>
  sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.permission === undefined || can(item.permission)),
    }))
    .filter((section) => section.items.length > 0);
