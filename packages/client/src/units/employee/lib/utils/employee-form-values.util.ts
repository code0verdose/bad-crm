import { SharedLib } from '@shared';

import { type EmployeeProfileFormValues } from '@units/employee/model';
import { type EmployeeFormSource } from '@units/employee/types/employee-form.types.js';

/**
 * The personnel document as the form's fields.
 *
 * The employment keys are optional in the contract — a caller who may not see them receives none —
 * so every fallback here is «this caller was not shown it», not «the person has not filled it in».
 *
 * That is why the fields they back are **disabled when the key is absent** rather than merely when
 * the caller lacks `employee:update`: an enabled field showing a fallback over a value the server
 * withheld is one save away from erasing it.
 *
 * It lives in the unit rather than beside the page it was written for
 * (`rules/naming-and-structure.mdc`: a helper next to a component is a helper in the wrong place):
 * mapping the unit's own document onto the unit's own form is knowledge about the entity, and the
 * page that rendered it had no other reason to hold it.
 *
 * It takes `EmployeeFormSource` rather than the wire type, which is what keeps `lib` from importing
 * `api` — see that interface for why the narrower shape is the truer signature and not a workaround.
 */
export const employeeFormValues = (profile: EmployeeFormSource): EmployeeProfileFormValues => ({
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
