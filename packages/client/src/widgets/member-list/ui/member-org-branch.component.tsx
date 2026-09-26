import { Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';

import { EmployeeLib, type EmployeeApi, type EmployeeTypes } from '@units/employee';

import classes from './member-list-ui.module.css';

export interface MemberOrgBranchProps {
  readonly branch: EmployeeTypes.OrgTreeNode<EmployeeApi.OrgChartNode>;
}

/**
 * One person and everybody under them.
 *
 * Recursive on itself: a branch of an org chart is an org chart. The depth is bounded by the data —
 * `buildOrgTree` breaks cycles before this ever sees them, so there is no runaway to guard against
 * here.
 */
export function MemberOrgBranch({ branch }: MemberOrgBranchProps) {
  const { node } = branch;

  return (
    <li className={classes['chartNode']}>
      <Link
        className={classes['personLink']}
        params={{ userId: node.userId }}
        to="/admin/members/$userId"
      >
        {EmployeeLib.personLabel(node, node.userId)}
      </Link>
      {node.jobTitle !== null && (
        <Text c="var(--bc-text-muted)" size="sm">
          {node.jobTitle}
        </Text>
      )}
      {branch.reports.length > 0 && (
        <ul className={classes['chart']}>
          {branch.reports.map((report) => (
            <MemberOrgBranch key={report.node.userId} branch={report} />
          ))}
        </ul>
      )}
    </li>
  );
}
