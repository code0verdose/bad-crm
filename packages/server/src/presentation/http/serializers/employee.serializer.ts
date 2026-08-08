import { type VisibleEmployeeProfile } from '@/application/iam/use-cases/write-employee-profile.use-case.js';

/**
 * A profile on the wire, in the two shapes one record can take.
 *
 * **The filtering is here, and it is by construction rather than by deletion**: each branch builds the
 * object it is allowed to build, so a field a caller may not see is never assigned rather than
 * assigned and removed. The difference matters the day somebody adds a field to the wrong branch —
 * a `delete profile.hiredAt` further down would have to be remembered, and this cannot be forgotten
 * because there is nowhere to forget it.
 *
 * **No key here begins with `cost`.** Rates live in `cost_rates` (M6), and this serializer is the
 * reason a reader can be sure of that without reading the table: the shape below is the whole
 * answer, and `test/unit/http/employee-serializer.test.ts` asserts the absence for every level —
 * including for an administrator, because separation of duties only means something if it survives
 * the moment somebody writes `isAdmin ? everything : …` (`permission-model.md` §4.1).
 */

/** What any colleague sees: who this is and how to work with them. */
export interface PublicEmployeeResponse {
  readonly userId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly managerId: string | null;
  readonly timezone: string;
  readonly skills: readonly string[];
}

/** What HR and the person themselves see: the employment, and the contact for an emergency. */
export interface PersonalEmployeeResponse extends PublicEmployeeResponse {
  readonly employmentType: string;
  readonly hiredAt: string | null;
  readonly terminatedAt: string | null;
  readonly weeklyCapacityHours: number;
  readonly emergencyContact: string | null;
}

export type EmployeeResponse = PublicEmployeeResponse | PersonalEmployeeResponse;

const asDate = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

export const serializeEmployee = (visible: VisibleEmployeeProfile): EmployeeResponse => {
  const { profile } = visible;
  const publicShape: PublicEmployeeResponse = {
    userId: profile.userId,
    email: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    jobTitle: profile.jobTitle,
    department: profile.department,
    managerId: profile.managerId,
    timezone: profile.timezone,
    skills: [...profile.skills],
  };

  if (!visible.audience.personal) return publicShape;

  return {
    ...publicShape,
    employmentType: profile.employmentType,
    // A date, not a timestamp: nobody is hired at 14:32, and an ISO instant would render as the day
    // before for half the planet.
    hiredAt: asDate(profile.hiredAt),
    terminatedAt: asDate(profile.terminatedAt),
    weeklyCapacityHours: profile.weeklyCapacityHours,
    emergencyContact: visible.emergencyContact,
  };
};
