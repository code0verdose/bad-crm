import { Group, Pagination, Text } from '@mantine/core';

import classes from './pagination-bar.module.css';

export interface PaginationBarProps {
  /** One-based, as it is written in the URL and read by a person. */
  readonly page: number;
  readonly perPage: number;
  /** How many rows the filter matched in total, not how many were fetched. */
  readonly total: number;
  readonly onPageChange: (page: number) => void;
}

/** `26–50 / 137`, and `0 / 0` when nothing matched — never a range that promises rows that are not there. */
const describeRange = (page: number, perPage: number, total: number): string => {
  if (total === 0) return '0 / 0';

  const first = (page - 1) * perPage + 1;

  return `${first}–${Math.min(page * perPage, total)} / ${total}`;
};

/**
 * The bar under a list: where the reader is, and how to go elsewhere.
 *
 * **The count is the point.** A pager that shows only page numbers leaves somebody unable to tell a
 * filter that matched a little from one that matched nothing, and unable to judge whether paging on
 * is worth it. Putting it here rather than in each screen is what stops half the lists from having it.
 *
 * It is `role="status"` so the number is announced when it changes: after a filter, the visible
 * result is a list that redrew, and a screen reader is otherwise told nothing at all.
 *
 * **Presentational.** No page state, no URL, no fetching — the URL is the source of truth for a list
 * (`rules/lists-and-filters.mdc`) and that belongs to the unit that owns the data. This draws the
 * numbers it is given and reports what was clicked.
 */
export function PaginationBar({ page, perPage, total, onPageChange }: PaginationBarProps) {
  const pages = Math.ceil(total / perPage);

  return (
    <Group className={classes['root']} justify="space-between" wrap="wrap">
      <Text c="var(--bc-text-muted)" role="status" size="sm">
        {describeRange(page, perPage, total)}
      </Text>
      {/* Hidden, not disabled: a disabled pager is something to look at and decide about, and with
          one page there is nothing to decide. */}
      {pages > 1 && (
        <Pagination
          // The four edge controls are icons, so without this they reach a screen reader as
          // «button, button, button, button». axe reports it as `button-name`, and it was reporting
          // it about this component until these were added — the keys are resolved by EPIC-008 like
          // every other string a component takes.
          getControlProps={(control) => ({ 'aria-label': `pagination.${control}` })}
          onChange={onPageChange}
          size="sm"
          total={pages}
          value={page}
          withEdges
        />
      )}
    </Group>
  );
}
