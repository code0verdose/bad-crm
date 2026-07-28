import { Skeleton, Stack } from '@mantine/core';

export interface TextSkeletonProps {
  /** Rows to draw. Match the shape being waited for, so the page does not jump when it arrives. */
  readonly lines?: number;
}

const DEFAULT_LINES = 3;

/**
 * The placeholder a screen shows while its first data is on the way.
 *
 * A skeleton, not a spinner: a spinner says «something is happening», a skeleton says «this much
 * content is coming, here», which is what keeps the layout from jumping when it does
 * (`rules/errors-and-toasts.mdc` §7).
 *
 * `aria-busy` on the container and `aria-hidden` on the bars is the pairing `rules/a11y.mdc` §16
 * asks for: assistive technology is told the region is loading and is not made to read out a dozen
 * meaningless boxes.
 */
export function TextSkeleton({ lines = DEFAULT_LINES }: TextSkeletonProps) {
  return (
    <Stack aria-busy="true" gap="xs" data-testid="text-skeleton">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} aria-hidden="true" height="var(--bc-row-height)" radius="sm" />
      ))}
    </Stack>
  );
}
