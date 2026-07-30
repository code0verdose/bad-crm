import { Button, Group, Pill, Text } from '@mantine/core';

import classes from './filter-bar.module.css';

export interface ActiveFilter {
  /** Stable id of the filter, reported back on removal. Never the label. */
  readonly id: string;
  /** i18n key of what the chip reads — «Статус: активные», not «status». */
  readonly labelKey: string;
}

export interface FilterBarProps {
  readonly active: readonly ActiveFilter[];
  readonly onRemove: (id: string) => void;
  readonly onReset: () => void;
}

/**
 * What is currently narrowing a list, drawn as things that can be taken off.
 *
 * The failure it prevents is the quiet one: a filter left on from a previous visit, a list that looks
 * empty, and nothing on screen explaining why. A chip per filter with its own remove control makes
 * the state visible and undoable in the same place.
 *
 * **Nothing active renders nothing**, reset included. A bar that is always present spends a row of
 * the screen saying «no filters are on», which is what the unfiltered list already says.
 *
 * **Presentational.** It does not read the URL and has no opinion about what a filter means — the URL
 * is the source of truth for a list and belongs to the unit that owns it
 * (`rules/lists-and-filters.mdc`). This draws what it is handed and reports what was clicked, by id
 * and never by label: a label is a translated string, and matching on it would break in Russian.
 */
export function FilterBar({ active, onRemove, onReset }: FilterBarProps) {
  if (active.length === 0) return null;

  return (
    <Group className={classes['root']} gap="xs" wrap="wrap">
      {/* Announced, because on a narrow screen the chips collapse behind a button and this number is
          all that is left of them. */}
      <Text c="var(--bc-text-muted)" role="status" size="sm">
        {active.length}
      </Text>
      {active.map((filter) => (
        <Pill
          key={filter.id}
          onRemove={() => {
            onRemove(filter.id);
          }}
          // `aria-hidden` and `tabIndex` are overridden deliberately. Mantine renders the remove
          // control of a `Pill` hidden from assistive technology and out of the tab order, which is
          // right where it comes from — inside `PillsInput`, removal is Backspace and the cross is a
          // mouse affordance. A filter chip standing on its own has no such keyboard path, so the
          // default would mean a filter that can be applied and not taken off without a mouse. axe
          // does not catch it either: an `aria-hidden` button is not a button it examines.
          removeButtonProps={{
            'aria-hidden': false,
            'aria-label': `filter.remove.${filter.id}`,
            tabIndex: 0,
          }}
          withRemoveButton
        >
          {filter.labelKey}
        </Pill>
      ))}
      <Button onClick={onReset} size="compact-sm" variant="subtle">
        filter.reset
      </Button>
    </Group>
  );
}
