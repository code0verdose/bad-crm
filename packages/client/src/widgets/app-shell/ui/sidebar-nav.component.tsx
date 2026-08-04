import { Box, NavLink, Stack, Text, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Link, useRouterState } from '@tanstack/react-router';

import { type NavSection } from '@widgets/app-shell';

import classes from './sidebar-nav.module.css';

export interface SidebarNavProps {
  /**
   * The navigation itself, handed in rather than imported.
   *
   * Not only for testability: a file under `ui/` reaching into the widget's `model/` folder needs a
   * `../`, which the layer rules forbid — and the alias that would replace it is a deep import into
   * this very widget, which they forbid too. Passing the data down is what the boundary is asking
   * for, and it leaves this component purely presentational.
   */
  readonly sections: readonly NavSection[];
  /** Folded to icons. The label survives as the accessible name and as a tooltip. */
  readonly isCollapsed?: boolean;
  /** Closing the drawer after a navigation is the drawer's business, not the list's. */
  readonly onNavigate?: () => void;
}

/**
 * The primary navigation: sections, links, and which one you are on.
 *
 * `aria-current="page"` is the part that matters and the part that is usually missing — colour
 * alone tells a sighted user where they are and tells a screen-reader user nothing
 * (`rules/a11y.mdc` §2). TanStack's `Link` sets `data-status="active"`, so the styling and the
 * semantics come from the same source of truth instead of two independent guesses.
 *
 * It renders a plain container, **not** a `<nav>`. Measured in a browser, not deduced:
 * `AppShell.Navbar` is itself a `<nav>` and takes no label of its own, so a `<nav>` here produced
 * two navigation landmarks nested one inside the other — the outer one unnamed, which is exactly
 * what `rules/a11y.mdc` §20 forbids. jsdom saw nothing wrong, because the test asked for the named
 * one and found it. The landmark is therefore declared by whoever hosts this list.
 *
 * Collapsed, every item keeps its accessible name — an icon rail of unnamed buttons is a navigation
 * only for whoever memorised the icons.
 */
export function SidebarNav({ sections, isCollapsed = false, onNavigate }: SidebarNavProps) {
  const { t } = useTranslation();

  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Box className={classes['root']}>
      <Stack gap="lg">
        {sections.map((section) => (
          <Stack gap={4} key={section.titleKey}>
            {!isCollapsed && (
              <Text c="var(--bc-text-muted)" className={classes['sectionTitle']} component="h2">
                {t(section.titleKey)}
              </Text>
            )}
            {section.items.map((item) => {
              const isActive = pathname === item.to || pathname.startsWith(`${item.to}/`);
              const Icon = item.icon;

              return (
                <Tooltip
                  disabled={!isCollapsed}
                  key={item.to}
                  label={t(item.labelKey)}
                  position="right"
                >
                  <NavLink
                    active={isActive}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={t(item.labelKey)}
                    component={Link}
                    leftSection={<Icon size={20} stroke={1.5} />}
                    to={item.to}
                    {...(isCollapsed ? {} : { label: t(item.labelKey) })}
                    {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
                  />
                </Tooltip>
              );
            })}
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}
