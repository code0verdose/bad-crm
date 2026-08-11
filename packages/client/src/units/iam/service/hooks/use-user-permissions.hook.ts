import { useCallback, useMemo, useState } from 'react';

import { type HeldRole } from '@units/iam/api';
import { calendarDayIn, expiryInstantOf, permissionRows } from '@units/iam/lib';
import {
  DEFAULT_ALLOW_DAYS,
  type PermissionChoice,
  type PermissionOverrideFormValues,
} from '@units/iam/model';
import { type PermissionRowGroup } from '@units/iam/types';
import {
  useRemovePermissionOverride,
  useWritePermissionOverride,
} from '@units/iam/service/mutations';
import { useUserPermissionsQuery } from '@units/iam/service/queries';

import { useCan } from './use-can.hook.js';

/** One frozen array, so «no answer yet» is the same reference on every render. */
const NO_ROLES: readonly HeldRole[] = [];

/** What the dialog is about while it is open: which key, and which way it is being moved. */
export interface OverrideDraft {
  readonly permission: string;
  readonly effect: 'ALLOW' | 'DENY';
  /** What the form starts with — thirty days out for an ALLOW, nothing chosen for a DENY. */
  readonly initialValues: PermissionOverrideFormValues;
}

export interface UserPermissionsController {
  readonly status: 'pending' | 'error' | 'success';
  readonly isOwner: boolean;
  readonly roles: readonly HeldRole[];
  readonly groups: readonly PermissionRowGroup[];
  /** True when the answer arrived and the two filters left nothing of it. */
  readonly isEmpty: boolean;
  /** Whether to draw a control at all — `permission:override`, the write half. */
  readonly canWrite: boolean;
  readonly isSaving: boolean;
  readonly draft: OverrideDraft | null;
  /**
   * Why the last write was refused, or `undefined`.
   *
   * Surfaced instead of toasted: the form is inside an `aria-modal` dialog, so the refusal has to
   * be rendered where the button was pressed (`rules/errors-and-toasts.mdc` §2 and the reasoning in
   * `write-permission-override.mutation.ts`).
   */
  readonly writeError: unknown;
  readonly refetch: () => void;
  /** A position was chosen on one row: opens the form, or removes the exception outright. */
  readonly choose: (permission: string, choice: PermissionChoice) => void;
  readonly cancel: () => void;
  /**
   * Writes the exception the form was filled in for.
   *
   * The draft travels **with** the call rather than being read back out of this hook's state, and
   * that is not ceremony: the only caller is a dialog that does not exist unless there is a draft,
   * so a second read here could only ever disagree with the one the person was looking at — and the
   * `if (draft === null) return` it would need is a branch no test can reach, which is a line of
   * untested code guarding an impossibility.
   */
  readonly confirm: (draft: OverrideDraft, values: PermissionOverrideFormValues) => void;
}

export interface UserPermissionsOptions {
  readonly userId: string;
  readonly search: string;
  readonly exceptionsOnly: boolean;
}

/**
 * The permissions tab of one personnel card, as one object a component can render.
 *
 * This is the unit's public API for `ui` (`rules/frontend-fsd.mdc` rule 6): the query, the two
 * mutations, the state of the dialog and the filtering all meet here, and the widget above receives
 * rows and handlers.
 *
 * **It decides nothing about permissions.** Every row carries the `source` the server assembled
 * from the one capability ladder (`permission-model.md` §«Слой 5»); what this hook adds is order,
 * names for `roleIds`, and which of the three positions the control is currently in — and that last
 * one is read off the presence of an exception, not off the ladder: `override.effect` *is* the
 * position, and «no exception» is the third.
 *
 * `canWrite` is a hint and never a gate. What it prevents is offering a control that would always
 * answer 403 (`ux-architecture.md`, принцип 6); the endpoint refuses on its own authority either
 * way.
 *
 * **The returned object is memoised, and every function on it is stable.** The widget's own search
 * box re-renders this hook on every keystroke — before the 300 ms debounce publishes anything — and
 * `search`/`exceptionsOnly`/`userId` do not change until it does; without this, the object literal
 * this function used to return was a fresh reference every one of those renders regardless, which
 * defeated the `memo` on `PermissionDomainGroup`/`PermissionRow` the widget's own comments claim to
 * rely on. `useMemo` here is what makes those comments true rather than aspirational.
 */
export const useUserPermissions = ({
  userId,
  search,
  exceptionsOnly,
}: UserPermissionsOptions): UserPermissionsController => {
  const query = useUserPermissionsQuery(userId);
  const write = useWritePermissionOverride();
  const remove = useRemovePermissionOverride();
  const { can } = useCan();
  const [draft, setDraft] = useState<OverrideDraft | null>(null);

  /**
   * Memoised because it walks the whole catalogue — three hundred keys — and the widget above
   * re-renders on every keystroke of its own search box.
   */
  const groups = useMemo(
    () =>
      query.data === undefined
        ? []
        : permissionRows({
            permissions: query.data.permissions,
            roles: query.data.roles,
            search,
            exceptionsOnly,
          }),
    [query.data, search, exceptionsOnly],
  );

  // TanStack Query's `mutate` is a stable reference across renders; read once so the `useCallback`s
  // below can depend on it directly instead of on the mutation object, which is not.
  const { mutate: removeMutate } = remove;
  const { mutate: writeMutate } = write;
  const { refetch: queryRefetch } = query;

  const choose = useCallback(
    (permission: string, choice: PermissionChoice): void => {
      if (choice === 'INHERITED') {
        // Nothing to ask: removing an exception needs no reason, and the row already says what will
        // be inherited once it is gone.
        //
        // No `setDraft(null)` here, on purpose. It sat here until this line: clearing a draft the
        // dialog is `aria-modal` over. While the dialog is open the row underneath is inert, for the
        // pointer and for a screen reader, so this branch cannot run while a draft exists to clear —
        // the same shape as `confirm`'s missing `if (draft === null) return` above, and as the
        // `enabled` guard `user-permissions.query.ts` used to carry before it was removed for the
        // identical reason (see that file's comment). A line no test can make fail is not a safety
        // net; it is a line that makes a real one look optional. If the dialog ever stops being
        // modal, this needs to come back deliberately, with a test that can see it fire.
        removeMutate({ userId, permission });

        return;
      }

      setDraft({
        permission,
        effect: choice,
        initialValues: {
          reason: '',
          neverExpires: false,
          // Thirty days for an ALLOW, nothing for a DENY — the two are different decisions
          // (STORY-011-11, acceptance 2). A widening is temporary until somebody says otherwise; a
          // withdrawal is the kind of thing an administrator should have to put a date on, or tick
          // «until somebody removes it» deliberately.
          expiresOn: choice === 'ALLOW' ? calendarDayIn(DEFAULT_ALLOW_DAYS, new Date()) : '',
        },
      });
    },
    [removeMutate, userId],
  );

  const cancel = useCallback(() => {
    setDraft(null);
  }, []);

  const confirm = useCallback(
    (draft: OverrideDraft, values: PermissionOverrideFormValues): void => {
      writeMutate(
        {
          userId,
          permission: draft.permission,
          override: {
            effect: draft.effect,
            reason: values.reason.trim(),
            // `null` is the contract's «until somebody removes it»; the day becomes the start of
            // that day in UTC, which is what the field's label says out loud.
            expiresAt: values.neverExpires ? null : expiryInstantOf(values.expiresOn),
          },
        },
        {
          onSuccess: () => {
            setDraft(null);
          },
        },
      );
    },
    [writeMutate, userId],
  );

  const refetch = useCallback(() => {
    void queryRefetch();
  }, [queryRefetch]);

  const isOwner = query.data?.isOwner ?? false;
  const roles = query.data?.roles ?? NO_ROLES;
  const isEmpty = query.data !== undefined && groups.length === 0;
  const canWrite = can('permission:override');
  const isSaving = write.isPending || remove.isPending;
  const { error: writeError } = write;

  return useMemo<UserPermissionsController>(
    () => ({
      status: query.status,
      isOwner,
      roles,
      groups,
      isEmpty,
      canWrite,
      isSaving,
      draft,
      writeError,
      refetch,
      choose,
      cancel,
      confirm,
    }),
    [
      query.status,
      isOwner,
      roles,
      groups,
      isEmpty,
      canWrite,
      isSaving,
      draft,
      writeError,
      refetch,
      choose,
      cancel,
      confirm,
    ],
  );
};
