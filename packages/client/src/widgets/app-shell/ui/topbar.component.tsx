import { ActionIcon, Burger, Group, Text, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';

import { SharedUi } from '@shared';

import { ProjectSwitcherBar } from '@widgets/project-switcher';

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
 * The sign-out control is the only way out of the shell, and a workspace with no way to leave it is
 * not a workspace anybody should open on a shared machine.
 *
 * This said «until the avatar menu of EPIC-007 exists» (corrected 2026-08-30). EPIC-007 shipped and
 * delivered no avatar menu — there is no avatar anywhere in the client, and the avatar itself waits
 * on EPIC-015 (file storage), which is what `epics/epic-012-employee-management/epic.md` records as
 * its blocker. So sign-out is not a placeholder for a menu that is about to land.
 *
 * The language switch sits beside the colour scheme because they answer the same kind of question —
 * how this workspace should look and read — and because the public screens carry the same control
 * (`widgets/public-screen`): somebody who set the language before signing in should find it in a
 * place that feels like the same control, not a different feature.
 *
 * The project switcher (STORY-014-06) sits beside the product mark. Global search (`Cmd+K`), the
 * running timer, notifications and the AI drawer belong here too; they arrive with the epics that
 * build them, and an empty button that does nothing would be worse than the gap.
 */
export function Topbar({
  isDrawerOpen,
  onToggleDrawer,
  isCollapsed,
  onToggleCollapse,
}: TopbarProps) {
  const { t } = useTranslation();

  const CollapseIcon = isCollapsed ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse;

  return (
    <Group className={classes['root']} h="100%" justify="space-between" px="md" wrap="nowrap">
      <Group gap="sm" wrap="nowrap">
        <Burger
          aria-label={t('nav.drawer.toggle')}
          hiddenFrom="sm"
          opened={isDrawerOpen}
          onClick={onToggleDrawer}
          size="sm"
        />
        <Tooltip label={t('nav.sidebar.toggle')}>
          <ActionIcon
            aria-label={t('nav.sidebar.toggle')}
            aria-pressed={isCollapsed}
            onClick={onToggleCollapse}
            variant="subtle"
            visibleFrom="sm"
          >
            <CollapseIcon size={20} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
        {/*
          Product name, not a translatable string — the same rule `index.html` follows, and the
          reason the disable is here rather than a word added to the rule's allow-list: an allow-list
          entry would silence «Bad CRM» wherever it appeared, including somewhere it was a mistake.
        */}
        {/* eslint-disable-next-line i18next/no-literal-string -- a proper noun */}
        <Text fw={600}>Bad CRM</Text>
        <ProjectSwitcherBar />
      </Group>

      <Group gap="sm" wrap="nowrap">
        <SharedUi.LanguageControl />
        <ColorSchemeControl />
        <SignOutControl />
      </Group>
    </Group>
  );
}
