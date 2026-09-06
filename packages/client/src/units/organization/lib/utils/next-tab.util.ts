import { ORGANIZATION_TABS, type OrganizationTab } from '@units/organization/model';

/**
 * The tab a click asks for — or the one already open, when it asks for a tab that does not exist.
 *
 * Mantine's `Tabs` reports `string | null`, so somebody has to decide what a value outside the set
 * means. It means «stay where you are»: the search schema would fall back to `security` anyway, and
 * a click that missed must not look like a click that landed somewhere else.
 *
 * **The previous tab is a parameter so that the answer is always a tab.** The obvious shape returns
 * `undefined` for a miss and leaves the caller with an `if` — a branch that, while the product has
 * one tab, nothing on screen can enter and no test can reach. Deciding here instead keeps the page
 * to markup and handlers (`rules/frontend-fsd.mdc` rule 10) and makes both outcomes provable.
 */
export const nextTab = (value: string | null, previous: OrganizationTab): OrganizationTab =>
  value !== null && (ORGANIZATION_TABS as readonly string[]).includes(value)
    ? (value as OrganizationTab)
    : previous;
