import { type DateProgress } from '@units/project/types';

const PERCENT = 100;

/**
 * The share of the span between `startedAt` and `dueAt` that `now` has left behind.
 *
 * `null` unless both dates are set: a project with no deadline has no span to measure, and inventing
 * one would draw a bar that means nothing. `now` is a parameter so the function is pure — the hook
 * reads the clock once per render and hands it in.
 */
export const dateProgress = (
  startedAt: string | null,
  dueAt: string | null,
  now: Date,
): DateProgress | null => {
  if (startedAt === null || dueAt === null) return null;

  const start = Date.parse(startedAt);
  const due = Date.parse(dueAt);
  const current = now.getTime();
  const isOverdue = current > due;

  // A zero-length span has no «share»: it is either still ahead or already behind.
  if (due <= start) return { percent: isOverdue ? PERCENT : 0, isOverdue };

  const share = Math.floor(((current - start) / (due - start)) * PERCENT);

  return { percent: Math.min(PERCENT, Math.max(0, share)), isOverdue };
};
