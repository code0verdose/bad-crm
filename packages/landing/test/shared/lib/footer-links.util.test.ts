import { describe, expect, it } from 'vitest';

import { FOOTER_COLUMN_TARGETS, pairFooterColumns } from '@/shared/lib/footer-links.util.js';

/**
 * The pairing is positional, so the interesting case is the one the live dictionaries never reach:
 * a label with no target beside it.
 *
 * `site-footer.widget.test.tsx` asserts the arity of both dictionaries against the table, which is
 * what keeps that case from happening. It also means the branch that handles it is never taken, and
 * an unexercised branch in a function that decides what a reader can click is worth one test rather
 * than a coverage exemption: the choice between dropping the line and rendering a dead link is a
 * decision the docstring makes, and this is where it is written down as behaviour.
 */
describe('pairFooterColumns', () => {
  it('pairs each label with the target that sits at its index', () => {
    const [product] = pairFooterColumns([
      { title: 'Product', links: ['Workspace', 'Domains', 'Security', 'Self-host'] },
    ]);

    expect(product?.title).toBe('Product');
    expect(product?.links.map((link) => link.label)).toEqual([
      'Workspace',
      'Domains',
      'Security',
      'Self-host',
    ]);
    expect(product?.links.map((link) => link.target)).toEqual(FOOTER_COLUMN_TARGETS[0]);
  });

  it('drops a label the table has no target for, rather than linking it nowhere', () => {
    const [product] = pairFooterColumns([
      { title: 'Product', links: ['Workspace', 'Domains', 'Security', 'Self-host', 'Roadmap'] },
    ]);

    expect(product?.links.map((link) => link.label)).toEqual([
      'Workspace',
      'Domains',
      'Security',
      'Self-host',
    ]);
    expect(product?.links.every((link) => link.target !== undefined)).toBe(true);
  });

  it('keeps a column whose labels are all unpaired, empty rather than absent', () => {
    // Third column: the table has two. The heading survives so the layout does not shift under a
    // dictionary that ran ahead of the table, and there is nothing in it to click.
    const columns = pairFooterColumns([
      { title: 'Product', links: [] },
      { title: 'Project', links: [] },
      { title: 'Later', links: ['Roadmap'] },
    ]);

    expect(columns).toHaveLength(3);
    expect(columns[2]).toEqual({ title: 'Later', links: [] });
  });
});
