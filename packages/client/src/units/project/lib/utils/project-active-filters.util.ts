import { PROJECT_STATUS_LABEL } from '@units/project/model/enums/project-status.enums.js';
import { type ProjectListSearch } from '@units/project/model/validation/project-list-search.schema.js';

/** A filter as the chip bar draws it: a stable id to report back and a key to translate. */
export interface ProjectActiveFilter {
  readonly id: string;
  readonly labelKey: string;
}

/** The prefix of a status chip's id — `status:ON_HOLD`. */
export const STATUS_CHIP_PREFIX = 'status:';

/**
 * What is narrowing `/projects`, as chips, in the order their controls stand on the screen
 * (`rules/lists-and-filters.mdc` §11).
 *
 * Keys, not text: the search and the lead are named by what they are rather than by their value,
 * because `FilterBar` translates a key and a key cannot carry a person's name. The value itself is
 * one glance away, in the control the chip stands for. Sort and view are not here: they change how
 * the projects read, not which ones they are.
 */
export const projectActiveFilters = (search: ProjectListSearch): ProjectActiveFilter[] => [
  ...(search.q === undefined ? [] : [{ id: 'q', labelKey: 'projects.list.filters.chip.query' }]),
  ...search.status.map((status) => ({
    id: `${STATUS_CHIP_PREFIX}${status}`,
    labelKey: PROJECT_STATUS_LABEL[status],
  })),
  ...(search.lead === undefined
    ? []
    : [{ id: 'lead', labelKey: 'projects.list.filters.chip.lead' }]),
  ...(search.member === undefined
    ? []
    : [{ id: 'member', labelKey: 'projects.list.filters.chip.mine' }]),
];
