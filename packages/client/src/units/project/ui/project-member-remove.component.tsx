import { Button } from '@mantine/core';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedLib, SharedUi } from '@shared';

export interface ProjectMemberRemoveProps {
  readonly userId: string;
  /** The person's name, for the accessible name — a column of identical «Remove» says nothing. */
  readonly name: string;
  /** Archived: reachable and explained, and pressing it does nothing. */
  readonly locked: boolean;
  /** The note that says why, while `locked`. */
  readonly lockedNoteId: string;
  /**
   * Whether this person's row is coming back from a refused removal — asked when the button
   * appears, answered `true` once; the button then takes focus again.
   */
  readonly claimReturn: (userId: string) => boolean;
  readonly onRemove: (userId: string) => void;
}

/**
 * «Remove» on one row of the roster.
 *
 * **Where focus goes is the reason this is its own component.** The removal is optimistic, so the
 * row — and this button, which held focus — leaves at once; `useRowFocusHandoff` sends focus to the
 * next row's button, the row above, or the section heading. A refused removal is rolled back and
 * the row returns as a *new* node, which is given focus again: the reader stands where they
 * pressed, now reading the toast that says why.
 *
 * **Archived, it stays reachable** (`rules/a11y.mdc` §23): `aria-disabled` with the disabled look,
 * described by the note beside the table, and no handler — the code refuses, not the attribute.
 */
export function ProjectMemberRemove({
  userId,
  name,
  locked,
  lockedNoteId,
  claimReturn,
  onRemove,
}: ProjectMemberRemoveProps) {
  const { t } = useTranslation();

  const takesFocus = useCallback(() => claimReturn(userId), [claimReturn, userId]);

  const ref = SharedUi.useRowFocusHandoff(takesFocus);

  return (
    <Button
      ref={ref}
      {...(locked ? SharedLib.lockedControlProps(lockedNoteId) : {})}
      aria-label={t('projects.members.removeOf', { name })}
      color="danger"
      data-row-action="remove"
      onClick={
        locked
          ? undefined
          : () => {
              onRemove(userId);
            }
      }
      size="xs"
      variant="subtle"
    >
      {t('projects.members.remove')}
    </Button>
  );
}
