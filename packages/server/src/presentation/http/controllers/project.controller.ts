import { type RequestHandler } from 'express';

import { type GetProjectDetailQuery } from '@/application/project/use-cases/get-project-detail.query.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import { serializeProjectDetail } from '@/presentation/http/serializers/project.serializer.js';
import { type projectIdParamsSchema } from '@/presentation/http/validators/project.validator.js';

export interface ProjectControllerDependencies {
  readonly getProjectDetail: GetProjectDetailQuery;
  readonly projectIdValidator: RequestValidator<{ params: typeof projectIdParamsSchema }>;
}

/**
 * Projects — the first domain with a resource layer under its routes.
 *
 * Handlers are wiring. Who may read *this* project is decided by `project-access.policy.ts` from
 * inside `GetProjectDetailQuery`: capability first, the ACL chain only after, the row last — and
 * every outsider (another organization's id, a `PRIVATE` project the caller is not on, a deleted
 * row, nothing at all) is one `404`, never a 403.
 */
export const createProjectController = (
  dependencies: ProjectControllerDependencies,
): { readonly detail: RequestHandler } => ({
  detail: async (_request, response) => {
    const { params } = dependencies.projectIdValidator.read(response);

    const project = await dependencies.getProjectDetail.execute({
      actor: readActor(response),
      projectId: params.projectId,
    });

    response.status(200).json(serializeProjectDetail(project));
  },
});
