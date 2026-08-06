import { type RequestHandler } from 'express';
import { type SharedPermissions } from '@bad-crm/shared';

import {
  type CreateCustomRoleUseCase,
  type UpdateCustomRoleUseCase,
} from '@/application/iam/use-cases/write-custom-role.use-case.js';
import { type DeleteCustomRoleUseCase } from '@/application/iam/use-cases/delete-custom-role.use-case.js';
import { type ListRolesQuery } from '@/application/iam/use-cases/list-roles.query.js';
import {
  type ApplyRoleChangesUseCase,
  type PreviewRoleChangesQuery,
} from '@/application/iam/use-cases/write-role-changes.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import {
  serializeCreatedRole,
  serializeRole,
  serializeRoleChangeOutcome,
} from '@/presentation/http/serializers/role.serializer.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import {
  type createRoleBodySchema,
  type roleChangesBodySchema,
  type roleIdParamsSchema,
  type updateRoleBodySchema,
} from '@/presentation/http/validators/custom-role.validator.js';

/**
 * The header a client repeats a refused request with.
 *
 * A header rather than a body field: the confirmation is about the request as a whole, and putting
 * it in the payload would make the same document mean two different things depending on a flag
 * inside it — which is how a client ends up sending it by default.
 */
const CONFIRM_DANGEROUS = 'x-confirm-dangerous';

export interface CustomRoleControllerDependencies {
  readonly listRoles: ListRolesQuery;
  readonly previewChanges: PreviewRoleChangesQuery;
  readonly applyChanges: ApplyRoleChangesUseCase;
  readonly changesValidator: RequestValidator<{ body: typeof roleChangesBodySchema }>;
  readonly createRole: CreateCustomRoleUseCase;
  readonly updateRole: UpdateCustomRoleUseCase;
  readonly deleteRole: DeleteCustomRoleUseCase;
  readonly createValidator: RequestValidator<{ body: typeof createRoleBodySchema }>;
  readonly updateValidator: RequestValidator<{
    params: typeof roleIdParamsSchema;
    body: typeof updateRoleBodySchema;
  }>;
  readonly deleteValidator: RequestValidator<{ params: typeof roleIdParamsSchema }>;
}

/**
 * Composing a role out of the catalogue — the operation the role matrix screen drives.
 *
 * Handlers are wiring. What may go into a role (only what the author holds), what may not be edited
 * at all (a system role) and what would lock the author out is decided by
 * `role-composition.policy.ts`, called from the use-case.
 */
export const createCustomRoleController = (
  dependencies: CustomRoleControllerDependencies,
): {
  readonly list: RequestHandler;
  readonly preview: RequestHandler;
  readonly apply: RequestHandler;
  readonly create: RequestHandler;
  readonly update: RequestHandler;
  readonly remove: RequestHandler;
} => ({
  list: async (_request, response) => {
    const roles = await dependencies.listRoles.execute({ actor: readActor(response) });

    response.status(200).json({ items: roles.map(serializeRole) });
  },

  preview: async (_request, response) => {
    const { body } = dependencies.changesValidator.read(response);

    const outcomes = await dependencies.previewChanges.execute({
      actor: readActor(response),
      changes: body.changes as { roleId: string; permissions: SharedPermissions.PermissionKey[] }[],
    });

    response.status(200).json({ items: outcomes.map(serializeRoleChangeOutcome) });
  },

  apply: async (request, response) => {
    const { body } = dependencies.changesValidator.read(response);

    await dependencies.applyChanges.execute({
      actor: readActor(response),
      changes: body.changes as { roleId: string; permissions: SharedPermissions.PermissionKey[] }[],
      confirmedDangerous: request.headers[CONFIRM_DANGEROUS] === '1',
    });

    response.status(204).send();
  },

  create: async (request, response) => {
    const { body } = dependencies.createValidator.read(response);

    const role = await dependencies.createRole.execute({
      actor: readActor(response),
      key: body.key,
      name: body.name,
      description: body.description ?? null,
      permissions: body.permissions as SharedPermissions.PermissionKey[],
      confirmedDangerous: request.headers[CONFIRM_DANGEROUS] === '1',
    });

    response.status(201).json(serializeCreatedRole(role));
  },

  update: async (request, response) => {
    const { params, body } = dependencies.updateValidator.read(response);

    await dependencies.updateRole.execute({
      actor: readActor(response),
      roleId: params.roleId,
      name: body.name,
      description: body.description ?? null,
      permissions: body.permissions as SharedPermissions.PermissionKey[],
      confirmedDangerous: request.headers[CONFIRM_DANGEROUS] === '1',
    });

    response.status(204).send();
  },

  remove: async (_request, response) => {
    const { params } = dependencies.deleteValidator.read(response);

    await dependencies.deleteRole.execute({
      actor: readActor(response),
      roleId: params.roleId,
    });

    response.status(204).send();
  },
});
