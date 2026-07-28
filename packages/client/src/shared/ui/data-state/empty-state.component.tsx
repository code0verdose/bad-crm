import { Stack, Text, Title } from '@mantine/core';
import { type ReactNode } from 'react';

import classes from './empty-state.module.css';

export interface EmptyStateProps {
  readonly titleKey: string;
  /** What to do next. Absent only when the emptiness is genuinely terminal. */
  readonly descriptionKey?: string;
  /** The primary action itself — a `Button`, a `Link`; the caller owns what it does. */
  readonly action?: ReactNode;
}

/**
 * «Nothing here» with a next step (`ux-architecture.md` → принцип 3).
 *
 * An empty state that only says «no data» is a dead end; the product rule is that it explains what
 * would put something here, which is why `titleKey` alone is not the whole component. Having it in
 * `shared/ui` is what stops fifteen screens from inventing fifteen different dead ends.
 */
export function EmptyState({ titleKey, descriptionKey, action }: EmptyStateProps) {
  return (
    <Stack align="center" className={classes['root']} gap="sm" data-testid="empty-state">
      <Title order={2} size="h3">
        {titleKey}
      </Title>
      {descriptionKey !== undefined && (
        <Text c="var(--bc-text-muted)" ta="center">
          {descriptionKey}
        </Text>
      )}
      {action}
    </Stack>
  );
}
