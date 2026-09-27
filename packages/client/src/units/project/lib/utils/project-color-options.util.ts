import { PROJECT_COLOR_LABEL, PROJECT_COLORS, type ProjectColor } from '@units/project/model';

export interface ProjectColorOption {
  readonly value: string;
  readonly labelKey: string;
  /** Only for a stored name outside the palette: the name itself, interpolated. */
  readonly values?: { readonly name: string };
}

const isPaletteColor = (color: string): color is ProjectColor =>
  (PROJECT_COLORS as readonly string[]).includes(color);

/**
 * The choices of the colour picker: the palette, plus the project's current colour when it is not
 * one of them.
 *
 * A project created by an older client, or by the API directly, can hold any well-formed name. A
 * picker that did not offer it would silently repaint the project on the first unrelated save —
 * `PATCH` replaces the whole project — so the stored value stays selectable, named as it is.
 */
export const projectColorOptions = (current?: string): readonly ProjectColorOption[] => {
  const palette = PROJECT_COLORS.map((value) => ({ value, labelKey: PROJECT_COLOR_LABEL[value] }));

  return current === undefined || current === '' || isPaletteColor(current)
    ? palette
    : [...palette, { value: current, labelKey: 'projects.color.other', values: { name: current } }];
};
