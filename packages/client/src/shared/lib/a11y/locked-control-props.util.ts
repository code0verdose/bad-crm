export interface LockedControlProps {
  readonly 'aria-disabled': true;
  readonly 'aria-describedby': string;
  readonly 'data-disabled': true;
}

/**
 * The attributes of a button that is unavailable **and stays reachable**: `aria-disabled` for what
 * a screen reader announces, `data-disabled` for Mantine's disabled look, and `aria-describedby`
 * pointing at the sentence that says why (`rules/a11y.mdc` §23).
 *
 * The hard `disabled` is what this replaces: it drops the control out of the tab order, and the
 * reader who most needs the reason — somebody moving through the screen by keyboard — never lands
 * on the control that would carry it.
 *
 * **Attributes describe; they do not refuse.** A control given these still fires its `onClick`,
 * so the caller withholds the handler as well. That is the reason this is a set of props rather
 * than a component: the handler is the caller's to drop.
 */
export const lockedControlProps = (reasonId: string): LockedControlProps => ({
  'aria-disabled': true,
  'aria-describedby': reasonId,
  'data-disabled': true,
});
