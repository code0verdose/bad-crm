import { Checkbox, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';

export interface RoleMatrixCellProps {
  readonly roleName: string;
  readonly permission: string;
  readonly granted: boolean;
  /** A system role, whose composition is code — the cell is readable and not editable. */
  readonly locked: boolean;
  readonly onToggle: () => void;
}

/**
 * One cell of the matrix: does this role grant this permission.
 *
 * **Binary, deliberately.** The third state — «explicitly denied» — exists one layer down, on the
 * personal-exceptions screen, and offering it here would suggest a role can deny, which it cannot
 * (`docs/security/permission-model.md` §12, divergence 3). A checkbox is exactly two states, which
 * is why it is a checkbox and not a tri-state control.
 *
 * A locked cell is disabled **and** explains itself: a control that cannot be used and says nothing
 * reads as a bug, and the reason — system roles are re-applied on every upgrade — is not something
 * anybody can guess from a grey box.
 */
export function RoleMatrixCell({
  roleName,
  permission,
  granted,
  locked,
  onToggle,
}: RoleMatrixCellProps) {
  const { t } = useTranslation();
  const reason = t('roles.cell.systemLocked');
  const label = t('roles.cell.label', { role: roleName, permission });

  const checkbox = (
    <Checkbox
      checked={granted}
      /**
       * `aria-disabled`, never `disabled`, while the cell is locked (`rules/a11y.mdc` §23).
       *
       * A hard-disabled control leaves the tab sequence, and with it the tooltip that explains why
       * it cannot be changed — so the one person who most needs the explanation, somebody driving
       * this table from the keyboard, is the one who cannot reach it. Announcing «disabled» is not
       * the same as enforcing it, which is why `onChange` refuses below rather than relying on the
       * attribute.
       */
      aria-disabled={locked || undefined}
      readOnly={locked}
      onChange={locked ? undefined : onToggle}
      /**
       * The reason travels in the accessible name, not only in the tooltip.
       *
       * A tooltip is a hover affordance first; a screen reader that announces «Manager, task:read,
       * checkbox, disabled» has told the person that they cannot, and nothing about why. Built-in
       * roles being re-applied on every upgrade is not guessable from a grey box.
       */
      aria-label={locked ? `${label}. ${reason}` : label}
      size="sm"
    />
  );

  if (!locked) return checkbox;

  return (
    <Tooltip
      label={reason}
      withArrow
      // Focus as well as hover: the control is now in the tab sequence, and a tooltip that only
      // answers the mouse would leave the keyboard path with the name and nothing else.
      events={{ hover: true, focus: true, touch: true }}
    >
      {/* The tooltip needs an element that emits pointer events over the whole cell, not only over
          the box itself. */}
      <span>{checkbox}</span>
    </Tooltip>
  );
}
