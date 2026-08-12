import { describe, expect, it } from 'vitest';

import { NAV_SECTIONS, visibleSections } from '@widgets/app-shell';

/**
 * The real navigation, not the fixture `visible-sections.test.ts` filters.
 *
 * That file proves `visibleSections` is a correct filter, against a section it wrote by hand — it
 * cannot, and does not try to, prove that `NAV_SECTIONS` itself declares the right permission for
 * every item. Removing `permission: 'team:read'` from the «Команды» entry
 * (`nav-sections.constant.ts:59`) left that suite green, because the fixture never had a `team:read`
 * item to begin with. This runs the same filter over the production constant instead.
 */
describe('what NAV_SECTIONS actually requires', () => {
  it('hides «Команды» from somebody who can read members and roles but not teams', () => {
    const granted = new Set(['user:read', 'role:read']);

    const sections = visibleSections(NAV_SECTIONS, (permission) => granted.has(permission));
    const labels = sections.flatMap((section) => section.items.map((item) => item.labelKey));

    expect(labels).toEqual([
      'nav.dashboard',
      'nav.settingsSecurity',
      'nav.adminMembers',
      'nav.adminRoles',
    ]);
  });

  it('shows «Команды» once team:read is granted, and nothing else administrative', () => {
    const sections = visibleSections(NAV_SECTIONS, (permission) => permission === 'team:read');
    const labels = sections.flatMap((section) => section.items.map((item) => item.labelKey));

    expect(labels).toEqual(['nav.dashboard', 'nav.settingsSecurity', 'nav.adminTeams']);
  });

  /**
   * And what survives that is the list of entries nobody can be denied.
   *
   * «Безопасность» is one of them on purpose: every operation behind `/settings/security` is
   * self-service — the route registry marks all four `selfService: true` — because nobody could be
   * denied the right to protect their own sign-in. An entry gated on a permission there would hide
   * the second factor from exactly the accounts that hold no permissions at all.
   */
  it('hides every administrative entry, «Команды» included, from somebody granted nothing', () => {
    const sections = visibleSections(NAV_SECTIONS, () => false);
    const labels = sections.flatMap((section) => section.items.map((item) => item.labelKey));

    expect(labels).toEqual(['nav.dashboard', 'nav.settingsSecurity']);
  });

  it('declares no permission on the two entries that are everybody’s', () => {
    const ungated = NAV_SECTIONS.flatMap((section) =>
      section.items.filter((item) => item.permission === undefined).map((item) => item.labelKey),
    );

    expect(ungated).toEqual(['nav.dashboard', 'nav.settingsSecurity']);
  });
});
