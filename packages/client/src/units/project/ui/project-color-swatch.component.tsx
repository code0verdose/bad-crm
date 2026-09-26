import { ColorSwatch } from '@mantine/core';

import { projectColorValue } from '@units/project/lib';

export interface ProjectColorSwatchProps {
  /** A palette name from the contract, e.g. `indigo`. */
  readonly color: string;
}

/**
 * The project's colour — decorative, and hidden from assistive technology for that reason: the key
 * and the name beside it are what identify the project, so the colour is never the only carrier of
 * meaning (STORY-014-05, acceptance 10; `rules/a11y.mdc` §2). A name that paints nothing draws
 * nothing rather than an empty circle.
 */
export function ProjectColorSwatch({ color }: ProjectColorSwatchProps) {
  const value = projectColorValue(color);

  if (value === undefined) return null;

  return <ColorSwatch aria-hidden color={value} size={16} withShadow={false} />;
}
