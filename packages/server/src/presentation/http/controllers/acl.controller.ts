import { type RequestHandler } from 'express';

import { type GrantAclUseCase } from '@/application/access/use-cases/grant-acl.use-case.js';
import { type ListResourceAclQuery } from '@/application/access/use-cases/list-resource-acl.query.js';
import { type RevokeAclUseCase } from '@/application/access/use-cases/revoke-acl.use-case.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import { serializeResourceAclEntry } from '@/presentation/http/serializers/acl.serializer.js';
import { clientOf } from '@/presentation/http/session-client.util.js';
import {
  type aclIdParamsSchema,
  type aclListQuerySchema,
  type grantAclBodySchema,
} from '@/presentation/http/validators/acl.validator.js';

export interface AclControllerDependencies {
  readonly listAcl: ListResourceAclQuery;
  readonly grantAcl: GrantAclUseCase;
  readonly revokeAcl: RevokeAclUseCase;
  readonly listValidator: RequestValidator<{ query: typeof aclListQuerySchema }>;
  readonly grantValidator: RequestValidator<{ body: typeof grantAclBodySchema }>;
  readonly aclIdValidator: RequestValidator<{ params: typeof aclIdParamsSchema }>;
}

/**
 * Grants on objects — STORY-011-06, the routes over the commands and the read.
 *
 * Wiring only. Who may read, give or take away a grant on *this* object is decided inside each
 * use-case by `acl-management.policy.ts` — the capability first, the object's chain after — and
 * every outsider is a `404`: the object's for a list or a grant, `acl_not_found` for a revocation
 * addressed by id. The address travels into both commands for the `WARNING` trail entry.
 */
export const createAclController = (
  dependencies: AclControllerDependencies,
): {
  readonly list: RequestHandler;
  readonly grant: RequestHandler;
  readonly revoke: RequestHandler;
} => ({
  list: async (_request, response) => {
    const { query } = dependencies.listValidator.read(response);

    const entries = await dependencies.listAcl.execute({
      actor: readActor(response),
      resource: { type: query.resourceType, id: query.resourceId },
    });

    response.status(200).json({ items: entries.map(serializeResourceAclEntry) });
  },

  grant: async (request, response) => {
    const { body } = dependencies.grantValidator.read(response);

    const { id } = await dependencies.grantAcl.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      resource: { type: body.resourceType, id: body.resourceId },
      subject: { type: body.subjectType, id: body.subjectId },
      level: body.accessLevel,
      expiresAt: body.expiresAt,
    });

    response.status(200).json({ id });
  },

  revoke: async (request, response) => {
    const { params } = dependencies.aclIdValidator.read(response);

    await dependencies.revokeAcl.execute({
      actor: readActor(response),
      ipAddress: clientOf(request).ipAddress,
      aclId: params.aclId,
    });

    response.status(204).send();
  },
});
