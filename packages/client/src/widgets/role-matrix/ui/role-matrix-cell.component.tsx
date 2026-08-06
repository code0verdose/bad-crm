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
  const label = t('roles.cell.label', { role: roleName, permission });

  const checkbox = (
    <Checkbox
      checked={granted}
      disabled={locked}
      onChange={onToggle}
      aria-label={label}
      size="sm"
    />
  );

  if (!locked) return checkbox;

  return (
    <Tooltip label={t('roles.cell.systemLocked')} withArrow>
      {/* A disabled control emits no pointer events, so the tooltip needs an element that does. */}
      <span>{checkbox}</span>
    </Tooltip>
  );
}
