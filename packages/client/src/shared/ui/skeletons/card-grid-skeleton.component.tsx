import { SimpleGrid, Skeleton, Stack } from '@mantine/core';

export interface CardGridSkeletonProps {
  /** Cards to draw. Match the page being waited for, so the grid does not jump when it arrives. */
  readonly cards?: number;
}

const DEFAULT_CARDS = 6;

/** Rows of text a placeholder card carries — a title line, a line of badges, a line of meta. */
const LINES_PER_CARD = 3;

/**
 * The placeholder a grid of cards shows while its first page is on the way — the card-shaped
 * sibling of `TextSkeleton`, for the same reason: a skeleton says how much is coming and where
 * (`rules/errors-and-toasts.mdc` §7).
 *
 * One to three columns by breakpoint — roughly where cards land on a screen of that width, which is
 * all a placeholder has to get right. Same pairing as `TextSkeleton` for assistive technology: `aria-busy` on the container, `aria-hidden` on
 * every bar (`rules/a11y.mdc` §16).
 */
export function CardGridSkeleton({ cards = DEFAULT_CARDS }: CardGridSkeletonProps) {
  return (
    <SimpleGrid aria-busy="true" cols={{ base: 1, sm: 2, lg: 3 }} data-testid="card-grid-skeleton">
      {Array.from({ length: cards }, (_, card) => (
        <Stack key={card} gap="xs">
          {Array.from({ length: LINES_PER_CARD }, (_line, line) => (
            <Skeleton key={line} aria-hidden="true" height="var(--bc-row-height)" radius="sm" />
          ))}
        </Stack>
      ))}
    </SimpleGrid>
  );
}
