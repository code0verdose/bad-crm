import { Stack, Text, Title } from '@mantine/core';
import { useId, type ReactNode } from 'react';

import classes from './section.module.css';

export interface SectionProps {
  /** i18n key of the section heading. Always rendered as `h2` — see below. */
  readonly titleKey: string;
  /** i18n key of an optional line under the heading, explaining what the section is for. */
  readonly descriptionKey?: string;
  readonly children?: ReactNode;
}

/**
 * The one way a page is divided below its `h1`.
 *
 * **It takes no heading level, and that is the feature.** A page split with styled `div`s has one
 * entry point and no outline for anybody navigating by headings; a page that reaches for `h3`
 * because `h2` «looks too big» has a hole in that outline which no visual review notices. Here the
 * level follows from the structure — `PageHeader` owns the single `h1`, a section is directly under
 * it, so it is `h2` — and there is no prop with which to disagree.
 *
 * **A labelled `region`, not a bare block.** `<section>` is only a landmark when it has an
 * accessible name, so the heading is wired to it with `aria-labelledby`: without that the element
 * carries the tag and none of its meaning, which is the kind of markup that passes review and helps
 * nobody. The id is generated per instance because a page has several.
 *
 * Anything richer — collapsing, a toolbar in the heading row, actions — belongs to the screen that
 * needs it and is passed as `children`. This component fixes the heading tree and nothing else
 * (`rules/design-system.mdc` §9).
 */
export function Section({ titleKey, descriptionKey, children }: SectionProps) {
  const headingId = useId();

  return (
    <Stack aria-labelledby={headingId} className={classes['root']} component="section" gap="sm">
      <Title id={headingId} order={2} size="h3">
        {titleKey}
      </Title>
      {descriptionKey !== undefined && (
        <Text c="var(--bc-text-muted)" size="sm">
          {descriptionKey}
        </Text>
      )}
      {children}
    </Stack>
  );
}
