import { type VisibleEmployeeProfile } from '@/application/iam/use-cases/write-employee-profile.use-case.js';

/**
 * A profile on the wire, in the four shapes one record can take.
 *
 * Four rather than two because the two questions are **independent**: how much of the employment
 * record this caller may read (`employee:view_personal_data`, or it being their own) and whether
 * they may see the state of the account (`user:read`, or it being their own). Neither implies the
 * other, and the use-case answers both before this file runs — `accountStatus` arrives `null` when
 * the second is refused, so there is no level to decide here (STORY-012-09, D4).
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

/** Additionally, for `user:read` and for the person themselves: whether the account is switched on. */
export interface AccountEmployeeResponse extends PublicEmployeeResponse {
  readonly status: string;
}

/** What HR and the person themselves see: the employment, and the contact for an emergency. */
export interface PersonalEmployeeResponse extends PublicEmployeeResponse {
  readonly employmentType: string;
  readonly hiredAt: string | null;
  readonly terminatedAt: string | null;
  readonly weeklyCapacityHours: number;
  readonly emergencyContact: string | null;
}

/** Both halves at once — the person reading their own record, and HR holding `user:read`. */
export interface PersonalAccountEmployeeResponse
  extends PersonalEmployeeResponse, AccountEmployeeResponse {}

export type EmployeeResponse =
  | PublicEmployeeResponse
  | AccountEmployeeResponse
  | PersonalEmployeeResponse
  | PersonalAccountEmployeeResponse;

const asDate = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

export const serializeEmployee = (visible: VisibleEmployeeProfile): EmployeeResponse => {
  const { profile, accountStatus } = visible;
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

  // `null` can only mean «this caller may not see it»: the column is `NOT NULL`, so there is no
  // state of an account that renders as an absent key by accident.
  if (!visible.audience.personal) {
    return accountStatus === null ? publicShape : { ...publicShape, status: accountStatus };
  }

  const personalShape: PersonalEmployeeResponse = {
    ...publicShape,
    employmentType: profile.employmentType,
    // A date, not a timestamp: nobody is hired at 14:32, and an ISO instant would render as the day
    // before for half the planet.
    hiredAt: asDate(profile.hiredAt),
    terminatedAt: asDate(profile.terminatedAt),
    weeklyCapacityHours: profile.weeklyCapacityHours,
    emergencyContact: visible.emergencyContact,
  };

  return accountStatus === null ? personalShape : { ...personalShape, status: accountStatus };
};
