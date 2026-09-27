/**
 * The palette a project's colour is picked from (`rules/a11y.mdc` §3: a user-chosen colour comes from
 * a vetted palette, never a free hex).
 *
 * **Only the measured families of the theme** (`app/theme/app-theme.config.ts`): Mantine's own hues
 * fail WCAG AA in the variants it derives from them, and `bad-crm/no-raw-mantine-color` refuses them
 * everywhere else in the client — a project picker that offered `teal` would be the one place they
 * came back. Every name matches the contract's `^[a-z][a-z0-9-]{0,31}$` and resolves to a variable
 * the theme declares (`--mantine-color-<name>-filled`, see `project-color.util.ts`).
 *
 * The swatch is decorative: the key and the name beside it identify a project, never the colour.
 */
export const PROJECT_COLORS = ['brand', 'info', 'success', 'warning', 'danger', 'neutral'] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

/** Written out, never built from the value: a key assembled at runtime is a key no gate can read. */
export const PROJECT_COLOR_LABEL: Readonly<Record<ProjectColor, string>> = {
  brand: 'projects.color.brand',
  info: 'projects.color.info',
  success: 'projects.color.success',
  warning: 'projects.color.warning',
  danger: 'projects.color.danger',
  neutral: 'projects.color.neutral',
};

/** What a new project is painted with until somebody picks otherwise. */
export const DEFAULT_PROJECT_COLOR: ProjectColor = 'brand';
