import { Group, Stack, Switch, TextInput } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { getRouteApi } from '@tanstack/react-router';
import { type SharedPermissions } from '@bad-crm/shared';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { RoleMatrix } from '@widgets/role-matrix';

const route = getRouteApi('/_authenticated/admin/roles');

/** Kept in step with `rolesSearchSchema`, which is what actually enforces it. */
const SEARCH_MAX_LENGTH = 64;

/**
 * `/admin/roles` — composition only (`rules/frontend-fsd.mdc` rule 7).
 *
 * The filters live in the URL and nothing else does: the search box is debounced before it gets
 * there, so typing does not fill the history with six entries, and the draft of unsaved toggles
 * stays out of it entirely — a link to a colleague has to mean what the organization currently is.
 */
export function AdminRolesPage() {
  const { t } = useTranslation();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [typed, setTyped] = useState(search.q);

  /**
   * Debounced in the **handler**, not in an effect: typing is an event, and an effect that mirrored
   * state into the URL would be the derived-state effect `rules/frontend-fsd.mdc` rule 11 forbids.
   * `replace: true` keeps six keystrokes from becoming six entries in the history — and is also why
   * the schema falls back instead of failing: a rejected value would stay in the address bar.
   */
  const publish = useDebouncedCallback((value: string) => {
    void navigate({
      search: (previous) => ({
        ...previous,
        q: value,
      }),
      replace: true,
    });
  }, 300);

  /**
   * Stable across renders, so the matrix below can be memoised.
   *
   * Typing in the search box re-renders this page on every keystroke — that is what a controlled
   * input does — and without a stable callback the matrix re-renders with it: three hundred rows
   * times a column per role, per character. Measured as a twenty-second test under load before this.
   */
  const toggleDomain = useCallback(
    (domain: SharedPermissions.PermissionDomain): void => {
      const { collapsed } = search;

      void navigate({
        search: (previous) => ({
          ...previous,
          collapsed: collapsed.includes(domain)
            ? collapsed.filter((entry) => entry !== domain)
            : [...collapsed, domain],
        }),
        replace: true,
      });
    },
    [navigate, search],
  );

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="roles.title" />

      <Group align="end" gap="md">
        <TextInput
          // The schema caps it too, and falls back rather than failing — but a field that silently
          // stops accepting input is kinder than one that accepts it and then drops it.
          maxLength={SEARCH_MAX_LENGTH}
          label={t('roles.searchLabel')}
          placeholder={t('roles.searchPlaceholder')}
          value={typed}
          onChange={(event) => {
            setTyped(event.currentTarget.value);
            publish(event.currentTarget.value.trim());
          }}
        />
        <Switch
          label={t('roles.onlyDifferences')}
          checked={search.diff}
          onChange={(event) => {
            const on = event.currentTarget.checked;

            void navigate({ search: (previous) => ({ ...previous, diff: on }), replace: true });
          }}
        />
      </Group>

      <RoleMatrix
        search={search.q}
        collapsed={search.collapsed}
        onlyDifferences={search.diff}
        onCollapse={toggleDomain}
      />
    </Stack>
  );
}
