import { type EmployeeApi, type EmployeeTypes } from '@units/employee';

import classes from './member-list-ui.module.css';
import { MemberOrgBranch } from './member-org-branch.component.js';

export interface MemberOrgChartProps {
  readonly tree: readonly EmployeeTypes.OrgTreeNode<EmployeeApi.OrgChartNode>[];
  /** The accessible name of the whole tree, resolved by the widget that owns the strings. */
  readonly label: string;
}

/**
 * Who reports to whom, as nested lists.
 *
 * Lists rather than boxes and connectors: a chart drawn with absolute positions is unreadable to a
 * screen reader and unusable from a keyboard, while nested `ul`/`li` is *already* a tree — the
 * indentation is presentation, and the structure is in the markup (`rules/a11y.mdc`). Tabbing walks
 * the people in the order the chart is read.
 *
 * Somebody whose manager is missing — deactivated, deleted, or simply not on this chart — is drawn
 * at the root by `buildOrgTree`, never dropped: a person absent from the chart of their own company
 * is a worse answer than one drawn in the wrong place.
 */
export function MemberOrgChart({ tree, label }: MemberOrgChartProps) {
  return (
    <ul aria-label={label} className={classes['chart']}>
      {tree.map((branch) => (
        <MemberOrgBranch key={branch.node.userId} branch={branch} />
      ))}
    </ul>
  );
}
