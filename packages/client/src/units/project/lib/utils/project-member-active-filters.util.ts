import { PROJECT_ROLE_LABEL } from '@units/project/model/enums/project-role.enums.js';
import { type ProjectMembersSearch } from '@units/project/model/validation/project-members-search.schema.js';

import { type ProjectActiveFilter } from './project-active-filters.util.js';

/** The prefix of a role chip's id — `role:LEAD`. */
export const ROLE_CHIP_PREFIX = 'role:';

/**
 * What is narrowing the roster, as chips, in the order their controls stand
 * (`rules/lists-and-filters.mdc` §11). The phrase is named by what it is, not by its value — a key
 * cannot carry what was typed, and the value is one glance away in the search box.
 */
export const projectMemberActiveFilters = (search: ProjectMembersSearch): ProjectActiveFilter[] => [
  ...(search.q === undefined ? [] : [{ id: 'q', labelKey: 'projects.members.filters.chip.query' }]),
  ...search.role.map((role) => ({
    id: `${ROLE_CHIP_PREFIX}${role}`,
    labelKey: PROJECT_ROLE_LABEL[role],
  })),
];
