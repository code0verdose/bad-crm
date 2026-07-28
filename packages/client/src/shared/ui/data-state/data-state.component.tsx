import { type ReactNode } from 'react';

import { ErrorState } from './error-state.component.js';

/** The three states of a TanStack Query result, spelled as the library spells them. */
export type DataStatus = 'pending' | 'error' | 'success';

export interface DataStateProps {
  readonly status: DataStatus;
  /** i18n key for the failure, chosen from the error `code` by the unit hook that owns the query. */
  readonly errorMessageKey?: string;
  readonly onRetry?: () => void;
  /** What to show while the first answer is on its way — a skeleton, never a spinner. */
  readonly skeleton: ReactNode;
  /** Shown instead of `children` when the answer arrived and contains nothing. */
  readonly empty?: ReactNode;
  readonly isEmpty?: boolean;
  readonly children: ReactNode;
}

/**
 * loading → error → empty → content, decided once (`rules/design-system.mdc` §10).
 *
 * Every screen owes the same four states, and every screen that decides them for itself gets one
 * of them wrong: the spinner that never resolves, the error with no way back, the empty list that
 * looks like a bug. Passing the query's `status` through one component is what makes «no bare
 * loading or error screens» checkable rather than aspirational.
 *
 * It takes a *message key*, not an error object: choosing the sentence from the `code` belongs to
 * the unit that knows what the operation was (`rules/errors-and-toasts.mdc` §10), and a shared
 * component that formats errors would have to know about domains.
 */
export function DataState({
  status,
  errorMessageKey = 'errors.unexpected',
  onRetry,
  skeleton,
  empty,
  isEmpty = false,
  children,
}: DataStateProps): ReactNode {
  if (status === 'pending') return skeleton;

  if (status === 'error') {
    return (
      <ErrorState messageKey={errorMessageKey} {...(onRetry === undefined ? {} : { onRetry })} />
    );
  }

  if (isEmpty && empty !== undefined) return empty;

  return children;
}
