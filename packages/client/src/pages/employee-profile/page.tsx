import { Button, Stack, Tabs } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { getRouteApi } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { SharedLib, SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { OffboardingDialog } from '@widgets/offboarding';
import { UserPermissions } from '@widgets/user-permissions';
import { EmployeeService, EmployeeUi, type EmployeeApi } from '@units/employee';
import { IamService } from '@units/iam';

const route = getRouteApi('/_authenticated/admin/members/$userId');

/**
 * `/admin/members/$userId` — the personnel record of one person.
 *
 * Composition only (`rules/frontend-fsd.mdc` rule 7). What the screen shows is decided by the
 * **server**: a caller without `employee:view_personal_data` receives a document with no employment
 * keys in it at all, so the form is built from what actually arrived rather than from what this
 * client believes it may see.
 */
export function EmployeeProfilePage() {
  const { t } = useTranslation();
  const { userId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const query = EmployeeService.EmployeeQueries.useEmployeeProfileQuery(userId);
  const save = EmployeeService.EmployeeMutations.useUpdateEmployeeProfile();
  const { can } = IamService.IamHooks.useCan();
  const [dialogOpened, dialogControls] = useDisclosure(false);

  /**
   * Whether this card has a second face at all.
   *
   * **A hint, not a gate.** The route itself carries no permission guard on purpose — a person
   * always reads their own personnel record — so the tab is what appears and disappears rather than
   * the page. Every request behind it is authorised again on the server, and the panel behind the
   * tab is never mounted for a caller without it (`keepMounted={false}` below), so the query it
   * holds never starts — a caller without the permission neither sees the tab nor spends a
   * guaranteed 403 on it.
   */
  const canReadPermissions = can('permission:override_read');

  /**
   * Derived at render, never mirrored into state (`rules/frontend-fsd.mdc` rule 11).
   *
   * `?tab=roles` reaching somebody without the permission falls back to the profile instead of
   * rendering a card with no body: the address is a link somebody shared, and «you may not read
   * this» is not what the page behind it is. There is nothing to conceal — the tab's absence is
   * already visible to them — and the alternative, a 403 screen over a personnel record the person
   * may otherwise read, would lock people out of a page they are entitled to.
   */
  const tab = search.tab === 'roles' && canReadPermissions ? 'roles' : 'profile';

  /**
   * Who the offboarding would be about — and `undefined` whenever there is nobody to offer it for.
   *
   * **One decision, not two.** The permission is a hint, never a gate: the endpoint refuses on its
   * own authority, and what the check prevents is offering an action that always answers 403
   * (`ux-architecture.md`, принцип 6). But a permission is not enough to draw the control: the
   * confirmation cannot ask anybody to type back an address the page has not got, so a button drawn
   * from `can(...)` alone is clickable while the document is still on its way — and for ever, if it
   * comes back 403, 404 or not at all — while opening nothing.
   *
   * The page already says «loading» and «this did not load» once, through `DataState` below.
   * Repeating either in the header, as a disabled control or a spinning one, would be a second
   * signal for one condition (`rules/errors-and-toasts.mdc` §2) — and a red button that explains
   * itself is still a red button offering an action that cannot be taken.
   */
  const subject = query.data !== undefined && can('user:suspend') ? query.data : undefined;

  return (
    <Stack gap="md">
      <SharedUi.PageHeader
        actions={
          subject === undefined ? undefined : (
            <Button color="red" onClick={dialogControls.open} variant="light">
              {t('offboarding.action')}
            </Button>
          )
        }
        breadcrumbs={<Breadcrumbs />}
        titleKey="employee.title"
      />

      {subject !== undefined && (
        <OffboardingDialog
          email={subject.email}
          onClose={dialogControls.close}
          opened={dialogOpened}
          userId={userId}
        />
      )}

      {/*
        `keepMounted={false}` states in the tree what must be true: the permissions tab issues a
        request when it mounts, and a card opened on the profile must not spend one on a table
        nobody has asked to see.

        It is **not** what makes that true today — Mantine's default `keepMountedMode: 'activity'`
        already destroys the effects of a hidden panel, so the query would not start either way, and
        removing this prop leaves the suite green. It stays because the property belongs to this
        screen rather than to a default of the UI kit, and because what is asserted is the
        behaviour, not the prop: `test/widgets/user-permissions.test.tsx` counts the reads before
        and after the tab is clicked.

        The tab itself is the only state of this screen that belongs in the URL — it is what makes
        «look at what Ivan may do» a link (`rules/frontend-fsd.mdc` rule 16).
      */}
      <Tabs
        keepMounted={false}
        onChange={(next) => {
          void navigate({
            search: (previous) => ({ ...previous, tab: next === 'roles' ? 'roles' : 'profile' }),
            replace: true,
          });
        }}
        value={tab}
      >
        <Tabs.List>
          <Tabs.Tab value="profile">{t('employee.tab.profile')}</Tabs.Tab>
          {canReadPermissions && <Tabs.Tab value="roles">{t('permissions.tab')}</Tabs.Tab>}
        </Tabs.List>

        <Tabs.Panel value="profile">
          <SharedUi.DataState
            // A key, not the error object: choosing the sentence from the `code` belongs to whoever
            // knows what the operation was (`rules/errors-and-toasts.mdc` §10).
            errorMessageKey="employee.loadFailed"
            onRetry={() => {
              void query.refetch();
            }}
            // The form is a column of text fields; the text skeleton is what it looks like while it
            // loads, and a bespoke one would be a second thing to keep in step with the form.
            skeleton={<SharedUi.TextSkeleton lines={8} />}
            status={query.status}
          >
            {query.data === undefined ? null : (
              <EmployeeUi.EmployeeProfileForm
                canEditEmployment={can('employee:update')}
                // «Did the document carry it», not «may this caller edit it»: the contact is
                // self-service, and the key is absent exactly when the server placed this caller
                // outside the personal audience for this person.
                carriesEmergencyContact={'emergencyContact' in query.data}
                initialValues={initialValuesOf(query.data)}
                isPending={save.isPending}
                onSubmit={(values) => {
                  save.mutate({ userId, patch: values });
                }}
              />
            )}
          </SharedUi.DataState>
        </Tabs.Panel>

        <Tabs.Panel value="roles">
          <UserPermissions
            exceptionsOnly={search.exceptions}
            onExceptionsChange={(value) => {
              void navigate({
                search: (previous) => ({ ...previous, exceptions: value }),
                replace: true,
              });
            }}
            onSearchChange={(value) => {
              void navigate({ search: (previous) => ({ ...previous, q: value }), replace: true });
            }}
            search={search.q}
            userId={userId}
          />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

/**
 * The document as the form's fields.
 *
 * The employment keys are optional in the contract — a caller who may not see them receives none —
 * so every fallback here is «this caller was not shown it», not «the person has not filled it in».
 *
 * That is why the fields they back are **disabled when the key is absent** rather than merely when
 * the caller lacks `employee:update`: an enabled field showing a fallback over a value the server
 * withheld is one save away from erasing it.
 */
const initialValuesOf = (profile: EmployeeApi.EmployeeProfile) => ({
  firstName: profile.firstName,
  lastName: profile.lastName,
  jobTitle: profile.jobTitle ?? '',
  department: profile.department ?? '',
  employmentType: profile.employmentType ?? 'FULL_TIME',
  weeklyCapacityHours: String(profile.weeklyCapacityHours ?? 40),
  timezone: profile.timezone || SharedLib.resolveTimeZone(),
  skills: profile.skills.join(', '),
  emergencyContact: profile.emergencyContact ?? '',
});
