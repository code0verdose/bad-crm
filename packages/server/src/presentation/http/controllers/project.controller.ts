import { type RequestHandler } from 'express';

import { type ArchiveProjectUseCase } from '@/application/project/use-cases/archive-project.use-case.js';
import { type ChangeProjectVisibilityUseCase } from '@/application/project/use-cases/change-project-visibility.use-case.js';
import { type CreateProjectUseCase } from '@/application/project/use-cases/create-project.use-case.js';
import { type DeleteProjectUseCase } from '@/application/project/use-cases/delete-project.use-case.js';
import { type GetProjectDetailQuery } from '@/application/project/use-cases/get-project-detail.query.js';
import { type ListProjectMembersQuery } from '@/application/project/use-cases/list-project-members.query.js';
import {
  type AddProjectMemberUseCase,
  type RemoveProjectMemberUseCase,
  type UpdateProjectMemberUseCase,
} from '@/application/project/use-cases/manage-project-members.use-case.js';
import { type UpdateProjectUseCase } from '@/application/project/use-cases/update-project.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import {
  serializeProjectDetail,
  serializeProjectMember,
} from '@/presentation/http/serializers/project.serializer.js';
import { clientOf } from '@/presentation/http/session-client.util.js';
import {
  type addProjectMemberBodySchema,
  type changeProjectVisibilityBodySchema,
  type createProjectBodySchema,
  type projectIdParamsSchema,
  type projectMemberParamsSchema,
  type projectMembersQuerySchema,
  type updateProjectBodySchema,
  type updateProjectMemberBodySchema,
} from '@/presentation/http/validators/project.validator.js';

/**
 * The header a caller repeats a dangerous request with — the same one the role surface reads
 * (`custom-role.controller.ts`): a header rather than a body field, because the confirmation is
 * about the request as a whole.
 */
const CONFIRM_DANGEROUS = 'x-confirm-dangerous';

export interface ProjectControllerDependencies {
  readonly getProjectDetail: GetProjectDetailQuery;
  readonly createProject: CreateProjectUseCase;
  readonly updateProject: UpdateProjectUseCase;
  readonly changeVisibility: ChangeProjectVisibilityUseCase;
  readonly archiveProject: ArchiveProjectUseCase;
  readonly deleteProject: DeleteProjectUseCase;
  readonly listMembers: ListProjectMembersQuery;
  readonly addMember: AddProjectMemberUseCase;
  readonly updateMember: UpdateProjectMemberUseCase;
  readonly removeMember: RemoveProjectMemberUseCase;
  readonly projectIdValidator: RequestValidator<{ params: typeof projectIdParamsSchema }>;
  readonly createValidator: RequestValidator<{ body: typeof createProjectBodySchema }>;
  readonly updateValidator: RequestValidator<{
    params: typeof projectIdParamsSchema;
    body: typeof updateProjectBodySchema;
  }>;
  readonly visibilityValidator: RequestValidator<{
    params: typeof projectIdParamsSchema;
    body: typeof changeProjectVisibilityBodySchema;
  }>;
  readonly membersQueryValidator: RequestValidator<{
    params: typeof projectIdParamsSchema;
    query: typeof projectMembersQuerySchema;
  }>;
  readonly addMemberValidator: RequestValidator<{
    params: typeof projectIdParamsSchema;
    body: typeof addProjectMemberBodySchema;
  }>;
  readonly updateMemberValidator: RequestValidator<{
    params: typeof projectMemberParamsSchema;
    body: typeof updateProjectMemberBodySchema;
  }>;
  readonly memberValidator: RequestValidator<{ params: typeof projectMemberParamsSchema }>;
}

/**
 * Projects — the first domain with a resource layer under its routes.
 *
 * Handlers are wiring. Who may read or change *this* project is decided by
 * `project-access.policy.ts` from inside each use-case: capability first, the ACL chain only after,
 * the row last — and every outsider (another organization's id, a `PRIVATE` project the caller is
 * not on, a deleted row, nothing at all) is one `404`, never a 403, on a read and on a mutation
 * alike. The address travels into every command for the trail.
 */
export const createProjectController = (
  dependencies: ProjectControllerDependencies,
): {
  readonly detail: RequestHandler;
  readonly create: RequestHandler;
  readonly update: RequestHandler;
  readonly changeVisibility: RequestHandler;
  readonly archive: RequestHandler;
  readonly remove: RequestHandler;
  readonly listMembers: RequestHandler;
  readonly addMember: RequestHandler;
  readonly updateMember: RequestHandler;
  readonly removeMember: RequestHandler;
} => ({
  detail: async (_request, response) => {
    const { params } = dependencies.projectIdValidator.read(response);

    const project = await dependencies.getProjectDetail.execute({
      actor: readActor(response),
      projectId: params.projectId,
    });

    response.status(200).json(serializeProjectDetail(project));
  },

  create: async (request, response) => {
    const { body } = dependencies.createValidator.read(response);

    const project = await dependencies.createProject.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      key: body.key,
      name: body.name,
      description: body.description,
      visibility: body.visibility,
      leadId: body.leadId,
      startedAt: body.startedAt,
      dueAt: body.dueAt,
      color: body.color,
    });

    response.status(201).json(serializeProjectDetail(project));
  },

  update: async (request, response) => {
    const { params, body } = dependencies.updateValidator.read(response);

    await dependencies.updateProject.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      projectId: params.projectId,
      name: body.name,
      description: body.description,
      leadId: body.leadId,
      startedAt: body.startedAt,
      dueAt: body.dueAt,
      color: body.color,
    });

    response.status(204).send();
  },

  changeVisibility: async (request, response) => {
    const { params, body } = dependencies.visibilityValidator.read(response);

    await dependencies.changeVisibility.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      projectId: params.projectId,
      visibility: body.visibility,
      confirmedDangerous: request.headers[CONFIRM_DANGEROUS] === '1',
    });

    response.status(204).send();
  },

  archive: async (request, response) => {
    const { params } = dependencies.projectIdValidator.read(response);

    await dependencies.archiveProject.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      projectId: params.projectId,
    });

    response.status(204).send();
  },

  remove: async (request, response) => {
    const { params } = dependencies.projectIdValidator.read(response);

    await dependencies.deleteProject.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      projectId: params.projectId,
    });

    response.status(204).send();
  },

  listMembers: async (_request, response) => {
    const { params, query } = dependencies.membersQueryValidator.read(response);

    const members = await dependencies.listMembers.execute({
      actor: readActor(response),
      projectId: params.projectId,
      includeLeft: query.includeLeft,
    });

    response.status(200).json({ items: members.map(serializeProjectMember) });
  },

  addMember: async (request, response) => {
    const { params, body } = dependencies.addMemberValidator.read(response);

    await dependencies.addMember.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      projectId: params.projectId,
      userId: body.userId,
      projectRole: body.projectRole,
      allocationPct: body.allocationPct,
    });

    response.status(204).send();
  },

  updateMember: async (request, response) => {
    const { params, body } = dependencies.updateMemberValidator.read(response);

    await dependencies.updateMember.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      projectId: params.projectId,
      userId: params.userId,
      ...(body.projectRole === undefined ? {} : { projectRole: body.projectRole }),
      ...(body.allocationPct === undefined ? {} : { allocationPct: body.allocationPct }),
    });

    response.status(204).send();
  },

  removeMember: async (request, response) => {
    const { params } = dependencies.memberValidator.read(response);

    await dependencies.removeMember.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      projectId: params.projectId,
      userId: params.userId,
    });

    response.status(204).send();
  },
});
