import {
  IconBuilding,
  IconKey,
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
  readonly to:
    | '/dashboard'
    | '/settings/security'
    | '/admin/members'
    | '/admin/teams'
    | '/admin/roles'
    | '/admin/organization';
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
    items: [
      { to: '/dashboard', labelKey: 'nav.dashboard', icon: IconLayoutDashboard },
      /**
       * No `permission`, and that is the point rather than an omission: every operation behind
       * `/settings/security` is self-service — the route registry marks each of them
       * `selfService: true`, because nobody could be denied the right to protect their own sign-in.
       * An entry everybody sees is the correct entry here.
       *
       * The count that used to stand here — «all four» — was written when there were four and went
       * stale when STORY-013-04 added `POST /auth/2fa/disable` (2026-08-30). A number is not worth
       * keeping when a command prints it:
       * `grep -c 'auth/2fa' packages/server/src/presentation/http/route-registry.factory.ts`
       * (subtract `2fa/verify`, which belongs to the login screen, not to this one).
       */
      { to: '/settings/security', labelKey: 'nav.settingsSecurity', icon: IconKey },
    ],
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
      /**
       * The entry is gated by the capability of the **one tab that exists**, not by
       * `organization:update` as `ux-architecture.md` plans for the finished screen. Today the
       * screen is the second-factor policy and nothing else, so somebody holding `organization:update`
       * alone would follow this link to a refusal — a menu entry that answers «not for you» is the
       * dead end principle 6 of that document forbids. When the other four tabs land, the guard
       * moves to the route and the security tab keeps its own.
       */
      {
        to: '/admin/organization',
        labelKey: 'nav.adminOrganization',
        icon: IconBuilding,
        permission: 'organization:manage_security_policy',
      },
    ],
  },
];
