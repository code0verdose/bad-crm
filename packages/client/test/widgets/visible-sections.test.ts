import { describe, expect, it } from 'vitest';

import { visibleSections } from '@widgets/app-shell';

/**
 * The menu, minus what this person cannot open.
 *
 * A hint rather than a gate — the route has its own guard and the server answers on its own
 * authority — but the property still has to hold, and it is the only reason the `permission` field
 * on a navigation item exists. Without a test the whole filter can be replaced by `identity` and
 * every other suite stays green: the shell renders either way.
 */

const SECTIONS = [
  {
    titleKey: 'nav.section.personal',
    items: [{ to: '/dashboard' as const, labelKey: 'nav.dashboard', icon: (() => null) as never }],
  },
  {
    titleKey: 'nav.section.administration',
    items: [
      {
        to: '/admin/roles' as const,
        labelKey: 'nav.adminRoles',
        icon: (() => null) as never,
        permission: 'role:read' as const,
      },
    ],
  },
];

describe('what the navigation offers', () => {
  it('keeps an entry whose permission the person holds', () => {
    const sections = visibleSections(SECTIONS, (permission) => permission === 'role:read');

    expect(sections.map((section) => section.titleKey)).toEqual([
      'nav.section.personal',
      'nav.section.administration',
    ]);
  });

  it('drops the entry, and the heading it was alone under', () => {
    // A section left with no items is a title over nothing — worse than absent, because it reads as
    // something that failed to load.
    const sections = visibleSections(SECTIONS, () => false);

    expect(sections.map((section) => section.titleKey)).toEqual(['nav.section.personal']);
  });

  it('leaves an entry that asks for no permission alone', () => {
    expect(visibleSections([SECTIONS[0] as never], () => false)).toHaveLength(1);
  });
});
