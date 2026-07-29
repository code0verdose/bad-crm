import { type RequestHandler } from 'express';

import { type EndSessionUseCase } from '@/application/identity/use-cases/end-session.use-case.js';
import { type ListSessionsQuery } from '@/application/identity/use-cases/list-sessions.query.js';
import { readCaller } from '@/presentation/http/middleware/authenticate.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import { clearRefreshCookie } from '@/presentation/http/refresh-cookie.util.js';
import {
  serializeRevokedCount,
  serializeSessionList,
} from '@/presentation/http/serializers/auth.serializer.js';
import { type sessionIdParamsSchema } from '@/presentation/http/validators/auth.validator.js';

export interface SessionControllerDependencies {
  readonly listSessions: ListSessionsQuery;
  readonly endSession: EndSessionUseCase;
  readonly sessionIdValidator: RequestValidator<{ params: typeof sessionIdParamsSchema }>;
}

/**
 * What `/settings/security` drives: the caller's own devices, and closing them.
 *
 * Every handler reads the caller from the guard and passes it to a use-case; **no handler decides
 * who may act on a row**. That decision is `requireSessionOwner`, called from
 * `EndSessionUseCase` — the place the route declarations name as `ownershipCheckedIn`, and the place
 * invariant 2 of CLAUDE.md requires it to be. A convenience check here would be a second point of
 * truth for the same question, and the one that gets it wrong is always the second one.
 */
export const createSessionController = (
  dependencies: SessionControllerDependencies,
): {
  readonly list: RequestHandler;
  readonly revoke: RequestHandler;
  readonly revokeOthers: RequestHandler;
} => ({
  list: async (_request, response) => {
    const caller = readCaller(response);

    const entries = await dependencies.listSessions.execute(
      { organizationId: caller.organizationId, userId: caller.userId },
      caller.sessionId,
    );

    response.json(serializeSessionList(entries));
  },

  revoke: async (_request, response) => {
    const caller = readCaller(response);
    const { params } = dependencies.sessionIdValidator.read(response);

    const { wasCurrent } = await dependencies.endSession.revoke(
      { organizationId: caller.organizationId, userId: caller.userId },
      params.sessionId,
      caller.sessionId,
    );

    // Only when the caller closed the device they are on — clearing the cookie of a browser that
    // just revoked *another* device would sign them out of the one they are looking at.
    if (wasCurrent) clearRefreshCookie(response);

    response.status(204).end();
  },

  revokeOthers: async (_request, response) => {
    const caller = readCaller(response);

    const revokedCount = await dependencies.endSession.revokeOthers(
      { organizationId: caller.organizationId, userId: caller.userId },
      caller.sessionId,
    );

    response.json(serializeRevokedCount(revokedCount));
  },
});
