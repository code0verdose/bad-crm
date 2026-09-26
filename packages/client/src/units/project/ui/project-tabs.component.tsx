import { Badge, Tabs } from '@mantine/core';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { PROJECT_SECTIONS, type ProjectSection } from '@units/project/model';

export interface ProjectTabsProps {
  /** The section whose route is on screen; its panel holds `children`. */
  readonly active: ProjectSection;
  /** The active section's content — the route's `<Outlet />`. */
  readonly children: ReactNode;
}

/**
 * The sections of a project card as a real tab list (`role="tablist"`, STORY-014-05 acceptance 10).
 *
 * Sections not shipped yet are **declared and disabled**, with «soon» in their accessible name —
 * so the list has its final shape, a disabled tab explains itself to a screen reader as well as to
 * the eye, and nothing leads to a 404 (acceptance 1). Mantine skips disabled tabs in arrow-key
 * navigation, which is the behaviour the WAI-ARIA tabs pattern asks for.
 *
 * Only the active section's panel is rendered: the others have no content to hold until their
 * routes exist.
 */
export function ProjectTabs({ active, children }: ProjectTabsProps) {
  const { t } = useTranslation();

  return (
    <Tabs keepMounted={false} value={active}>
      <Tabs.List aria-label={t('projects.section.label')}>
        {PROJECT_SECTIONS.map((section) => (
          <Tabs.Tab
            key={section.value}
            disabled={!section.available}
            rightSection={
              section.available ? undefined : (
                <Badge size="xs" variant="light">
                  {t('projects.section.soon')}
                </Badge>
              )
            }
            value={section.value}
          >
            {t(section.labelKey)}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <Tabs.Panel pt="md" value={active}>
        {children}
      </Tabs.Panel>
    </Tabs>
  );
}
