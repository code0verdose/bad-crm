import { ActionIcon, Burger, Group, Text, Tooltip } from '@mantine/core';
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';

import { ColorSchemeControl } from './color-scheme-control.component.js';
import { SignOutControl } from './sign-out-control.component.js';
import classes from './topbar.module.css';

export interface TopbarProps {
  readonly isDrawerOpen: boolean;
  readonly onToggleDrawer: () => void;
  readonly isCollapsed: boolean;
  readonly onToggleCollapse: () => void;
}

/**
 * The header: the two controls that change the shape of the shell, and the product mark.
 *
 * Both controls are icon-only and therefore both carry an `aria-label` — a `Tooltip` is not an
 * accessible name (`rules/a11y.mdc` §17), it is a hint for people who can see it. The burger is
 * `hiddenFrom="sm"` and the collapse control `visibleFrom="sm"`, because they do different things:
 * one opens a drawer over the content, the other narrows a rail beside it.
 *
 * The sign-out control is the third: it is the only way out of the shell until the avatar menu of
 * EPIC-007 exists, and a workspace with no way to leave it is not a workspace anybody should open
 * on a shared machine.
 *
 * Global search (`Cmd+K`), the project switcher, the running timer, notifications and the AI drawer
 * belong here too; they arrive with the epics that build them, and an empty button that does
 * nothing would be worse than the gap.
 */
export function Topbar({
  isDrawerOpen,
  onToggleDrawer,
  isCollapsed,
  onToggleCollapse,
}: TopbarProps) {
  const CollapseIcon = isCollapsed ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse;

  return (
    <Group className={classes['root']} h="100%" justify="space-between" px="md" wrap="nowrap">
      <Group gap="sm" wrap="nowrap">
        <Burger
          aria-label="nav.drawer.toggle"
          hiddenFrom="sm"
          opened={isDrawerOpen}
          onClick={onToggleDrawer}
          size="sm"
        />
        <Tooltip label="nav.sidebar.toggle">
          <ActionIcon
            aria-label="nav.sidebar.toggle"
            aria-pressed={isCollapsed}
            onClick={onToggleCollapse}
            variant="subtle"
            visibleFrom="sm"
          >
            <CollapseIcon size={20} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
        {/* Product name, not a translatable string — the same rule `index.html` follows. */}
        <Text fw={600}>Bad CRM</Text>
      </Group>

      <Group gap="sm" wrap="nowrap">
        <ColorSchemeControl />
        <SignOutControl />
      </Group>
    </Group>
  );
}
