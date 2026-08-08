import { Stack } from '@mantine/core';
import { getRouteApi } from '@tanstack/react-router';

import { SharedLib, SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
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
  const { userId } = route.useParams();
  const query = EmployeeService.EmployeeQueries.useEmployeeProfileQuery(userId);
  const save = EmployeeService.EmployeeMutations.useUpdateEmployeeProfile();
  const { can } = IamService.IamHooks.useCan();

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="employee.title" />

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
