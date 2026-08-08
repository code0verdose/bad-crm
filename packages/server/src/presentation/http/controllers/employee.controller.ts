import { type RequestHandler } from 'express';

import { type GetOrgChartQuery } from '@/application/iam/use-cases/get-org-chart.query.js';
import { type ListEmployeesQuery } from '@/application/iam/use-cases/list-employees.query.js';
import {
  type ReadEmployeeProfileQuery,
  type WriteEmployeeProfileUseCase,
} from '@/application/iam/use-cases/write-employee-profile.use-case.js';
import { type BuildActorQuery } from '@/application/iam/use-cases/build-actor.query.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { readCaller } from '@/presentation/http/middleware/authenticate.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import { serializeEmployee } from '@/presentation/http/serializers/employee.serializer.js';
import {
  serializeEmployeeList,
  serializeOrgChart,
} from '@/presentation/http/serializers/employee-list-item.serializer.js';
import { type employeeDirectoryQuerySchema } from '@/presentation/http/validators/employee-directory.validator.js';
import {
  type employeeProfileBodySchema,
  type userIdParamsSchema,
} from '@/presentation/http/validators/employee.validator.js';

export interface EmployeeControllerDependencies {
  /**
   * These two routes are self-service **and** capability-gated at once — a person always edits their
   * own name, and anybody else's record needs `employee:update` — so no permission guard runs and
   * there is no actor waiting on the response. It is built here from the caller of the token, with
   * the same query the guard uses on every other route: one implementation, two call sites.
   */
  readonly buildActor: BuildActorQuery;
  readonly readProfile: ReadEmployeeProfileQuery;
  readonly writeProfile: WriteEmployeeProfileUseCase;
  readonly listEmployees: ListEmployeesQuery;
  readonly getOrgChart: GetOrgChartQuery;
  readonly readValidator: RequestValidator<{ params: typeof userIdParamsSchema }>;
  readonly writeValidator: RequestValidator<{
    params: typeof userIdParamsSchema;
    body: typeof employeeProfileBodySchema;
  }>;
  readonly listValidator: RequestValidator<{ query: typeof employeeDirectoryQuerySchema }>;
}

/**
 * The personnel record of one person.
 *
 * Handlers are wiring. **Who may edit which field** — everybody their own name, `employee:update`
 * for anybody else's and for the employment fields — is decided by `employee-access.policy.ts` from
 * inside the use-case, and **how much of the answer a caller sees** is decided there too: the
 * serializer builds the shape the decision names, and builds no other.
 *
 * A date arrives as `YYYY-MM-DD` and is turned into a `Date` here, at the boundary. The use-case
 * takes dates because a use-case that parsed strings would be a second place where «what does this
 * date mean» is decided.
 */
export const createEmployeeController = (
  dependencies: EmployeeControllerDependencies,
): {
  readonly read: RequestHandler;
  readonly write: RequestHandler;
  readonly list: RequestHandler;
  readonly orgChart: RequestHandler;
} => ({
  /**
   * The directory. Guarded by `employee:read`, so the actor comes from the guard — unlike the two
   * self-service handlers below, which have none and build one from the caller of the token.
   */
  list: async (_request, response) => {
    const { query } = dependencies.listValidator.read(response);

    const page = await dependencies.listEmployees.execute({
      actor: readActor(response),
      filter: {
        query: query.q,
        statuses: query.status,
        roleIds: query.role,
        teamIds: query.team,
        sort: query.sort,
        page: query.page,
        perPage: query.perPage,
      },
    });

    response.status(200).json(serializeEmployeeList(page));
  },

  orgChart: async (_request, response) => {
    const nodes = await dependencies.getOrgChart.execute({ actor: readActor(response) });

    response.status(200).json(serializeOrgChart(nodes));
  },

  read: async (_request, response) => {
    const { params } = dependencies.readValidator.read(response);

    const visible = await dependencies.readProfile.execute({
      actor: await dependencies.buildActor.execute(readCaller(response)),
      subjectUserId: params.userId,
    });

    response.status(200).json(serializeEmployee(visible));
  },

  write: async (_request, response) => {
    const { params, body } = dependencies.writeValidator.read(response);

    const visible = await dependencies.writeProfile.execute({
      actor: await dependencies.buildActor.execute(readCaller(response)),
      subjectUserId: params.userId,
      patch: {
        // Spread field by field rather than passed through: an absent optional must stay absent
        // instead of becoming an explicit `undefined`, because «absent» and «null» mean different
        // things to a PATCH and the policy counts the keys that are actually there.
        ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
        ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
        ...(body.jobTitle === undefined ? {} : { jobTitle: body.jobTitle }),
        ...(body.department === undefined ? {} : { department: body.department }),
        ...(body.managerId === undefined ? {} : { managerId: body.managerId }),
        ...(body.weeklyCapacityHours === undefined
          ? {}
          : { weeklyCapacityHours: body.weeklyCapacityHours }),
        ...(body.employmentType === undefined ? {} : { employmentType: body.employmentType }),
        ...(body.hiredAt === undefined ? {} : { hiredAt: asDate(body.hiredAt) }),
        ...(body.terminatedAt === undefined ? {} : { terminatedAt: asDate(body.terminatedAt) }),
        ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
        ...(body.skills === undefined ? {} : { skills: body.skills }),
        ...(body.emergencyContact === undefined ? {} : { emergencyContact: body.emergencyContact }),
      },
    });

    response.status(200).json(serializeEmployee(visible));
  },
});

/** `YYYY-MM-DD` → the UTC midnight of that day, which is what a `DATE` column stores. */
const asDate = (value: string | null): Date | null =>
  value === null ? null : new Date(`${value}T00:00:00.000Z`);
