import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { previewRoleChanges, type RoleChangeOutcome, type RoleChanges } from '@units/iam/api';

/**
 * «What would happen if I saved this» — a read, issued as a mutation on purpose.
 *
 * It writes nothing, but it is not a query either: it has no cacheable address, because its input is
 * a draft that exists only in one person's browser and changes with every click. `useMutation` is
 * the hook for «run this when I say so and give me the result», which is exactly the shape here.
 *
 * No `onError` toast: the preview is opened by pressing Save, and the global `MutationCache` handler
 * already turns a failure into one red notification. A second one here would be the duplicate
 * `rules/errors-and-toasts.mdc` forbids.
 */
export const useRoleChangesPreview = (): UseMutationResult<
  readonly RoleChangeOutcome[],
  Error,
  RoleChanges
> =>
  useMutation({
    mutationFn: (changes: RoleChanges) => previewRoleChanges(changes),
  });
