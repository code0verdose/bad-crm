import { type OrgChartEdge, type OrgTreeNode } from '@units/employee/types/org-chart.types.js';

/**
 * Flat nodes into the tree a chart is drawn from.
 *
 * The server answers flat — one query, every edge — because nesting is a rendering decision and a
 * recursive response would be the same rows behind a schema no other caller wants. This is where the
 * decision is made, once, and it has to survive three things the data can genuinely be:
 *
 *   * **a manager who is not in the list.** A deactivated or deleted account still leaves
 *     `managerId` pointing at it; the report is drawn at the root rather than dropped, because a
 *     person missing from the chart of their own company is worse than one drawn in the wrong place;
 *   * **a cycle.** The server refuses to create one (`manager_cycle_detected`, 422), but a chart
 *     that loops forever on data it did not expect is a frozen tab, and «the server promised» is not
 *     a reason to hang. Anybody unreachable from a root is drawn at the root;
 *   * **somebody who reports to themselves.** The database forbids it
 *     (`ck_employee_profiles_manager_not_self`); the same treatment covers it for free.
 *
 * Order is preserved from the answer, which is sorted by surname — a chart that reshuffles siblings
 * between visits is a chart nobody can point at.
 */
export const buildOrgTree = <TNode extends OrgChartEdge>(
  nodes: readonly TNode[],
): readonly OrgTreeNode<TNode>[] => {
  const present = new Set(nodes.map((node) => node.userId));
  const reportsOf = new Map<string, TNode[]>();
  const roots: TNode[] = [];

  for (const node of nodes) {
    const managerId = node.managerId;

    // A manager who is not in the answer is not a manager as far as this chart is concerned.
    if (managerId === null || managerId === node.userId || !present.has(managerId)) {
      roots.push(node);
      continue;
    }

    const siblings = reportsOf.get(managerId);

    if (siblings === undefined) reportsOf.set(managerId, [node]);
    else siblings.push(node);
  }

  // Whoever the walk never reaches is in a cycle. They are drawn at the root, so the chart shows
  // every person exactly once even when the edges are impossible.
  const visited = new Set<string>();
  const expand = (node: TNode): OrgTreeNode<TNode> => {
    visited.add(node.userId);

    return {
      node,
      reports: (reportsOf.get(node.userId) ?? [])
        .filter((report) => !visited.has(report.userId))
        .map(expand),
    };
  };

  const tree = roots.map(expand);
  const stranded: OrgTreeNode<TNode>[] = [];

  // A loop rather than `filter(...).map(expand)`: expanding the first member of a cycle visits the
  // rest of it, and a list filtered before the walk would still hold them — drawing the same person
  // twice, once as a root and once under their own report.
  for (const node of nodes) {
    if (!visited.has(node.userId)) stranded.push(expand(node));
  }

  return [...tree, ...stranded];
};
