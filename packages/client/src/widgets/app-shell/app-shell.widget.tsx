import { AppShell as MantineAppShell, Box, Drawer } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { type ReactNode } from 'react';

import { SharedHooks } from '@shared';

import { NAV_SECTIONS } from './model/nav-sections.constant.js';
import { SidebarNav } from './ui/sidebar-nav.component.js';
import { MAIN_CONTENT_ID, SkipLink } from './ui/skip-link.component.js';
import { Topbar } from './ui/topbar.component.js';

/** Wide enough for two words of Russian navigation, which is the longer of the two locales. */
const NAVBAR_WIDTH = 260;

/** Icon rail: the icon plus its focus ring, and nothing else. */
const NAVBAR_COLLAPSED_WIDTH = 72;

const HEADER_HEIGHT = 56;

/** Below this the rail becomes a drawer — `sm` is 48em, the `768px` of the story. */
const NAVBAR_BREAKPOINT = 'sm';

export interface AppShellProps {
  readonly children: ReactNode;
}

/**
 * The frame every authenticated screen lives in: header, navigation, content.
 *
 * Three decisions are worth naming.
 *
 * **The mobile navigation is a `Drawer`, not the collapsed navbar.** `AppShell` can hide the navbar
 * below a breakpoint, but what it produces is a panel that slides over the page with the content
 * behind it still focusable — tabbing walks straight out of the open menu into the page underneath
 * it. `Drawer` traps focus, closes on `Esc` and returns focus to the burger, which is what
 * `rules/a11y.mdc` §7 asks for and what a user with no mouse actually needs.
 *
 * **The density is an attribute, not a class.** `tokens.css` keys `--bc-row-height` off
 * `[data-bc-density='compact']`, so a dense table needs no prop drilling and no context — it reads
 * a variable that is already in scope.
 *
 * **`AppShell.Main` is the `<main>` landmark**, and it carries the id the skip link points at.
 * Mantine renders it as `<main>`, so wrapping it in another one would be two main landmarks — a
 * failure `axe` reports and a screen reader acts on.
 */
export function AppShell({ children }: AppShellProps) {
  const [isDrawerOpen, drawer] = useDisclosure(false);
  const { isCollapsed, toggle: toggleCollapse } = SharedHooks.useSidebarCollapse();
  const { density } = SharedHooks.useDensity();

  return (
    <MantineAppShell
      data-bc-density={density}
      header={{ height: HEADER_HEIGHT }}
      navbar={{
        width: isCollapsed ? NAVBAR_COLLAPSED_WIDTH : NAVBAR_WIDTH,
        breakpoint: NAVBAR_BREAKPOINT,
        // Always collapsed on mobile: below the breakpoint the drawer below is the navigation.
        collapsed: { mobile: true },
      }}
      padding="md"
    >
      <SkipLink />

      <MantineAppShell.Header>
        <Topbar
          isCollapsed={isCollapsed}
          isDrawerOpen={isDrawerOpen}
          onToggleCollapse={toggleCollapse}
          onToggleDrawer={drawer.toggle}
        />
      </MantineAppShell.Header>

      {/* `AppShell.Navbar` *is* the `<nav>` landmark; naming it here is what keeps it from being
          an anonymous one, and stops the list inside from declaring a second. */}
      <MantineAppShell.Navbar aria-label="nav.primary.aria">
        <SidebarNav isCollapsed={isCollapsed} sections={NAV_SECTIONS} />
      </MantineAppShell.Navbar>

      <Drawer
        hiddenFrom={NAVBAR_BREAKPOINT}
        onClose={drawer.close}
        opened={isDrawerOpen}
        padding="sm"
        size="80%"
        title="nav.drawer.title"
      >
        <Box aria-label="nav.drawer.aria" component="nav">
          <SidebarNav onNavigate={drawer.close} sections={NAV_SECTIONS} />
        </Box>
      </Drawer>

      <MantineAppShell.Main id={MAIN_CONTENT_ID}>{children}</MantineAppShell.Main>
    </MantineAppShell>
  );
}
