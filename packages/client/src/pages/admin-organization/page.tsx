import { Stack, Tabs } from '@mantine/core';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { OrganizationLib, type OrganizationService } from '@units/organization';
import { Breadcrumbs } from '@widgets/breadcrumbs';
import { SecurityPolicy } from '@widgets/security-policy';

const route = getRouteApi('/_authenticated/admin/organization');

/**
 * `/admin/organization` — composition only (`rules/frontend-fsd.mdc` rule 7).
 *
 * **One tab today, and the tab list is still real.** `ux-architecture.md` plans five —
 * `general`, `branding`, `locale`, `security`, `storage` — and each arrives with its panel; a tab
 * rendered before its screen exists is a control that does nothing, which is worse than a screen
 * with one tab on it.
 *
 * The open tab lives in the URL beside the coverage filters, so `?tab=security&gate=grace` is a link
 * a colleague can be sent (`rules/lists-and-filters.mdc` §1). Every write is `replace`, which is why
 * the schema falls back rather than failing: a rejected value would stay in the address bar and a
 * reload would not clear it.
 *
 * `now` is created here and passed down, so that every relative deadline on the screen is measured
 * from the same instant and a test can state one.
 */
export function AdminOrganizationPage() {
  const { t } = useTranslation();
  const search = route.useSearch();
  const navigate = route.useNavigate();

  /**
   * The router's `navigate`, narrowed to what the unit needs.
   *
   * Wrapped rather than passed through, because `units/` must not depend on the generated route tree
   * — it lives two layers above — and because `navigate` answers a promise nobody here awaits. The
   * wrapper is also what makes the filter hook testable without a router.
   */
  const write = useCallback<OrganizationService.OrganizationHooks.CoverageSearchNavigation>(
    (input) => {
      void navigate({ search: input.search, replace: input.replace });
    },
    [navigate],
  );

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="organization.title" />

      <Tabs
        onChange={(value: string | null) => {
          void navigate({
            search: (previous) => ({
              ...previous,
              tab: OrganizationLib.nextTab(value, previous.tab),
            }),
            replace: true,
          });
        }}
        value={search.tab}
      >
        <Tabs.List>
          <Tabs.Tab value="security">{t('organization.tab.security')}</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel pt="md" value="security">
          <SecurityPolicy navigate={write} now={new Date()} search={search} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
