import { IconLayoutDashboard, type Icon } from '@tabler/icons-react';

/**
 * The navigation, as data (`ux-architecture.md` → «Информационная архитектура»).
 *
 * Four sections are planned — «Личное», «Работа команды», «Delivery», «Администрирование» — and a
 * section appears here when it has a route to point at. `to` is typed against the generated route
 * tree, so a link to a screen that does not exist is a compile error rather than a 404 the user
 * finds first; that is also why the list is short today and grows one epic at a time instead of
 * shipping a menu of dead entries.
 *
 * Labels are keys (`rules/i18n.mdc` §5): the catalogue is `nav.json` in both languages (EPIC-008).
 */
export interface NavItem {
  /** A path of the route tree. Widening this to `string` would give up the compile-time check. */
  readonly to: '/dashboard';
  readonly labelKey: string;
  readonly icon: Icon;
}

export interface NavSection {
  readonly titleKey: string;
  readonly items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    titleKey: 'nav.section.personal',
    items: [{ to: '/dashboard', labelKey: 'nav.dashboard', icon: IconLayoutDashboard }],
  },
];
