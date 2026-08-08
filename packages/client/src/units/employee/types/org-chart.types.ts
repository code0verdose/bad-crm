/**
 * What the tree builder needs of a node, and no more.
 *
 * Declared here rather than taken from `api`, and not only because `lib` may not import `api`
 * (`test/architecture/layers.test.ts`): assembling a tree needs an identity and an edge, and
 * *anything* carrying those two can be assembled. The generated wire type satisfies this
 * structurally, so nothing is duplicated — the narrower interface is the honest statement of what
 * the function reads.
 */
export interface OrgChartEdge {
  readonly userId: string;
  /** `null` is a root of the chart — somebody who reports to nobody. */
  readonly managerId: string | null;
}

/** A node with everybody under it. Generic, so the caller keeps the fields it will draw. */
export interface OrgTreeNode<TNode extends OrgChartEdge> {
  readonly node: TNode;
  readonly reports: readonly OrgTreeNode<TNode>[];
}
