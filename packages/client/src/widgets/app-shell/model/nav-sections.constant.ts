import {
  IconLayoutDashboard,
  IconShieldLock,
  IconUsers,
  IconUsersGroup,
  type Icon,
} from '@tabler/icons-react';
import { type SharedPermissions } from '@bad-crm/shared';

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
  readonly to: '/dashboard' | '/admin/members' | '/admin/teams' | '/admin/roles';
  readonly labelKey: string;
  readonly icon: Icon;
  /**
   * Hidden from anybody who does not hold it.
   *
   * A hint, never a gate: the route has its own guard and the server answers every request on its
   * own authority. What this prevents is a menu of entries that answer «not found» — an interface
   * showing dead ends (`ux-architecture.md`, principle 6).
   */
  readonly permission?: SharedPermissions.PermissionKey;
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
  {
    titleKey: 'nav.section.administration',
    items: [
      {
        to: '/admin/members',
        labelKey: 'nav.adminMembers',
        icon: IconUsers,
        permission: 'user:read',
      },
      {
        to: '/admin/teams',
        labelKey: 'nav.adminTeams',
        icon: IconUsersGroup,
        permission: 'team:read',
      },
      {
        to: '/admin/roles',
        labelKey: 'nav.adminRoles',
        icon: IconShieldLock,
        permission: 'role:read',
      },
    ],
  },
];
