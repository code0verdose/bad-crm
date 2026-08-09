import { type RequestHandler } from 'express';

import { type DeleteTeamUseCase } from '@/application/iam/use-cases/delete-team.use-case.js';
import { type GetTeamDetailQuery } from '@/application/iam/use-cases/get-team-detail.query.js';
import { type ListTeamsQuery } from '@/application/iam/use-cases/list-teams.query.js';
import {
  type AddTeamMemberUseCase,
  type RemoveTeamMemberUseCase,
} from '@/application/iam/use-cases/manage-team-members.use-case.js';
import {
  type CreateTeamUseCase,
  type UpdateTeamUseCase,
} from '@/application/iam/use-cases/write-team.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import {
  serializeCreatedTeam,
  serializeTeam,
  serializeTeamDetail,
} from '@/presentation/http/serializers/team.serializer.js';
import {
  type addTeamMemberBodySchema,
  type createTeamBodySchema,
  type teamIdParamsSchema,
  type teamMemberParamsSchema,
  type updateTeamBodySchema,
} from '@/presentation/http/validators/team.validator.js';

export interface TeamControllerDependencies {
  readonly listTeams: ListTeamsQuery;
  readonly getTeamDetail: GetTeamDetailQuery;
  readonly createTeam: CreateTeamUseCase;
  readonly updateTeam: UpdateTeamUseCase;
  readonly deleteTeam: DeleteTeamUseCase;
  readonly addMember: AddTeamMemberUseCase;
  readonly removeMember: RemoveTeamMemberUseCase;
  readonly createValidator: RequestValidator<{ body: typeof createTeamBodySchema }>;
  readonly updateValidator: RequestValidator<{
    params: typeof teamIdParamsSchema;
    body: typeof updateTeamBodySchema;
  }>;
  readonly teamIdValidator: RequestValidator<{ params: typeof teamIdParamsSchema }>;
  readonly addMemberValidator: RequestValidator<{
    params: typeof teamIdParamsSchema;
    body: typeof addTeamMemberBodySchema;
  }>;
  readonly memberValidator: RequestValidator<{ params: typeof teamMemberParamsSchema }>;
}

/**
 * Teams — the org-structure screen.
 *
 * Handlers are wiring. Who may act is decided by `team-access.policy.ts` from the use-case; whether
 * the id names anything is decided there too, and answered `404` rather than 403 for a team of
 * another organization.
 */
export const createTeamController = (
  dependencies: TeamControllerDependencies,
): {
  readonly list: RequestHandler;
  readonly detail: RequestHandler;
  readonly create: RequestHandler;
  readonly update: RequestHandler;
  readonly remove: RequestHandler;
  readonly addMember: RequestHandler;
  readonly removeMember: RequestHandler;
} => ({
  list: async (_request, response) => {
    const teams = await dependencies.listTeams.execute({ actor: readActor(response) });

    response.status(200).json({ items: teams.map(serializeTeam) });
  },

  detail: async (_request, response) => {
    const { params } = dependencies.teamIdValidator.read(response);

    const team = await dependencies.getTeamDetail.execute({
      actor: readActor(response),
      teamId: params.teamId,
    });

    response.status(200).json(serializeTeamDetail(team));
  },

  create: async (_request, response) => {
    const { body } = dependencies.createValidator.read(response);

    const team = await dependencies.createTeam.execute({
      actor: readActor(response),
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
    });

    response.status(201).json(serializeCreatedTeam(team));
  },

  update: async (_request, response) => {
    const { params, body } = dependencies.updateValidator.read(response);

    await dependencies.updateTeam.execute({
      actor: readActor(response),
      teamId: params.teamId,
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
    });

    response.status(204).send();
  },

  remove: async (_request, response) => {
    const { params } = dependencies.teamIdValidator.read(response);

    await dependencies.deleteTeam.execute({
      actor: readActor(response),
      teamId: params.teamId,
    });

    response.status(204).send();
  },

  addMember: async (_request, response) => {
    const { params, body } = dependencies.addMemberValidator.read(response);

    await dependencies.addMember.execute({
      actor: readActor(response),
      teamId: params.teamId,
      userId: body.userId,
      teamRole: body.teamRole,
    });

    response.status(204).send();
  },

  removeMember: async (_request, response) => {
    const { params } = dependencies.memberValidator.read(response);

    await dependencies.removeMember.execute({
      actor: readActor(response),
      teamId: params.teamId,
      userId: params.userId,
    });

    response.status(204).send();
  },
});
