import { describe, expect, it } from 'vitest';

import { type OrgChartNode } from '@units/employee/api';
import { type OrgTreeNode } from '@units/employee/types/org-chart.types.js';

import { buildOrgTree } from './build-org-tree.util.js';

/**
 * Flat nodes into a tree, including from data the server says it will never send.
 *
 * The server refuses to create a cycle (`manager_cycle_detected`, 422) and the database refuses
 * self-management outright — and neither is a reason for this to hang. A chart that loops forever on
 * unexpected edges is a frozen tab, and the rows arrive over a network from a version of the server
 * this build has never met.
 *
 * The invariant every case shares: **everybody is drawn exactly once.**
 */

const node = (userId: string, managerId: string | null = null): OrgChartNode => ({
  userId,
  firstName: userId,
  lastName: userId,
  jobTitle: null,
  managerId,
});

const flatten = (tree: readonly OrgTreeNode<OrgChartNode>[]): string[] =>
  tree.flatMap((branch) => [branch.node.userId, ...flatten(branch.reports)]);

describe('an ordinary chart', () => {
  it('nests the reports under their manager', () => {
    const tree = buildOrgTree([node('boss'), node('ivan', 'boss'), node('olga', 'ivan')]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.node.userId).toBe('boss');
    expect(tree[0]?.reports[0]?.node.userId).toBe('ivan');
    expect(tree[0]?.reports[0]?.reports[0]?.node.userId).toBe('olga');
  });

  it('puts somebody who reports to nobody at the root', () => {
    expect(buildOrgTree([node('ivan')]).map((branch) => branch.node.userId)).toEqual(['ivan']);
  });

  it('keeps the order the answer arrived in', () => {
    // Sorted by surname on the server. A chart that reshuffles siblings between visits is one nobody
    // can point at.
    const tree = buildOrgTree([node('boss'), node('a', 'boss'), node('b', 'boss')]);

    expect(tree[0]?.reports.map((branch) => branch.node.userId)).toEqual(['a', 'b']);
  });
});

describe('data the chart has to survive', () => {
  it('draws somebody whose manager is not on the chart at the root', () => {
    // A deactivated or deleted account still leaves `managerId` pointing at it. A person missing
    // from the chart of their own company is a worse answer than one drawn in the wrong place.
    const tree = buildOrgTree([node('ivan', 'gone')]);

    expect(tree.map((branch) => branch.node.userId)).toEqual(['ivan']);
  });

  it('does not hang on a cycle, and draws everybody in it', () => {
    const tree = buildOrgTree([node('a', 'b'), node('b', 'a')]);

    expect(flatten(tree).sort()).toEqual(['a', 'b']);
  });

  it('draws somebody who manages themselves', () => {
    const tree = buildOrgTree([node('ivan', 'ivan')]);

    expect(tree.map((branch) => branch.node.userId)).toEqual(['ivan']);
  });

  it('draws every person exactly once, cycle or not', () => {
    const nodes = [node('boss'), node('ivan', 'boss'), node('a', 'b'), node('b', 'a')];
    const drawn = flatten(buildOrgTree(nodes));

    expect(drawn).toHaveLength(nodes.length);
    expect(new Set(drawn).size).toBe(nodes.length);
  });

  it('answers an empty chart with an empty tree', () => {
    expect(buildOrgTree([])).toEqual([]);
  });
});
