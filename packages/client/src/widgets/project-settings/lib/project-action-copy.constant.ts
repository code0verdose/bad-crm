/**
 * The sentences of the three confirmations of the settings section, as keys.
 *
 * One dialog renders all three, because they are one policy — say what will be true afterwards,
 * ask, show the refusal where the button was pressed (`rules/design-system.mdc` §8, §17). What
 * differs is the words, and the words live here. The consequences are listed **before** the button:
 * somebody should be able to decide from the dialog rather than from what they find afterwards.
 * Who loses or gains access by a change of visibility is not a fixed sentence but the server's
 * count, rendered by the dialog's `summary` slot (`ProjectUi.ProjectVisibilityImpact`).
 */
export interface ProjectActionCopy {
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly consequenceKeys: readonly string[];
  readonly confirmKey: string;
  readonly failedTitleKey: string;
  /** Painted `danger` — the action cannot be taken back from this screen. */
  readonly isDestructive: boolean;
}

export type ProjectActionKind = 'close' | 'open' | 'archive' | 'delete';

export const PROJECT_ACTION_COPY: Readonly<Record<ProjectActionKind, ProjectActionCopy>> = {
  close: {
    titleKey: 'projects.visibility.close.title',
    descriptionKey: 'projects.visibility.close.description',
    consequenceKeys: ['projects.visibility.close.consequence.members'],
    confirmKey: 'projects.visibility.close.confirm',
    failedTitleKey: 'projects.visibility.failed',
    isDestructive: true,
  },
  open: {
    titleKey: 'projects.visibility.open.title',
    descriptionKey: 'projects.visibility.open.description',
    consequenceKeys: ['projects.visibility.open.consequence.members'],
    confirmKey: 'projects.visibility.open.confirm',
    failedTitleKey: 'projects.visibility.failed',
    isDestructive: true,
  },
  archive: {
    titleKey: 'projects.archive.title',
    descriptionKey: 'projects.archive.description',
    consequenceKeys: [
      'projects.archive.consequence.readOnly',
      'projects.archive.consequence.noReturn',
    ],
    confirmKey: 'projects.archive.confirm',
    failedTitleKey: 'projects.archive.failed',
    isDestructive: false,
  },
  delete: {
    titleKey: 'projects.delete.title',
    descriptionKey: 'projects.delete.description',
    consequenceKeys: [
      'projects.delete.consequence.hidden',
      'projects.delete.consequence.access',
      'projects.delete.consequence.key',
    ],
    confirmKey: 'projects.delete.confirm',
    failedTitleKey: 'projects.delete.failed',
    isDestructive: true,
  },
};
