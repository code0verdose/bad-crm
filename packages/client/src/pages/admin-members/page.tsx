import { Button, Stack } from '@mantine/core';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { MemberList } from '@widgets/member-list';
import { type EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';

const route = getRouteApi('/_authenticated/admin/members/');

/**
 * `/admin/members` — composition only (`rules/frontend-fsd.mdc` rule 7).
 *
 * It reads the typed search of the route and hands it, with a way to write it back, to the widget.
 * The filter logic — debounce, page reset, which change is a filter at all — lives in the unit's
 * hook, and the URL is the only state there is.
 */
export function AdminMembersPage() {
  const { t } = useTranslation();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { can } = IamService.IamHooks.useCan();

  /**
   * The router's `navigate`, narrowed to what the unit needs.
   *
   * Wrapped rather than passed through, because `units/` must not depend on the generated route tree
   * — it lives two layers above. The wrapper is also what makes the hook testable without a router.
   */
  const write = useCallback<EmployeeService.EmployeeHooks.SearchNavigation>(
    (input) => {
      void navigate({ search: input.search, replace: input.replace });
    },
    [navigate],
  );

  return (
    <Stack gap="md">
      <SharedUi.PageHeader
        actions={
          can('invitation:create') ? (
            <Button component={Link} to="/admin/members/invite">
              {t('members.invite.title')}
            </Button>
          ) : undefined
        }
        breadcrumbs={<Breadcrumbs />}
        titleKey="members.title"
      />

      <MemberList navigate={write} search={search} />
    </Stack>
  );
}
