import { type Request, type RequestHandler } from 'express';

import { type EndSessionUseCase } from '@/application/identity/use-cases/end-session.use-case.js';
import { type SessionClient } from '@/application/identity/use-cases/issue-session.use-case.js';
import { type LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { type RefreshSessionUseCase } from '@/application/identity/use-cases/refresh-session.use-case.js';
import { type RegisterOrganizationUseCase } from '@/application/identity/use-cases/register-organization.use-case.js';
import { UnauthenticatedError } from '@/domain/shared/errors/app.errors.js';
import { readCaller } from '@/presentation/http/middleware/authenticate.middleware.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from '@/presentation/http/refresh-cookie.util.js';
import {
  serializeAuthenticatedSession,
  serializeOrganizationSelection,
} from '@/presentation/http/serializers/auth.serializer.js';
import {
  type loginBodySchema,
  type registerBodySchema,
} from '@/presentation/http/validators/auth.validator.js';

export interface AuthControllerDependencies {
  readonly register: RegisterOrganizationUseCase;
  readonly login: LoginUseCase;
  readonly refresh: RefreshSessionUseCase;
  readonly endSession: EndSessionUseCase;
  readonly registerValidator: RequestValidator<{ body: typeof registerBodySchema }>;
  readonly loginValidator: RequestValidator<{ body: typeof loginBodySchema }>;
}

/**
 * The peer address, as far as the process is allowed to believe it.
 *
 * `req.ip` and not `X-Forwarded-For` read by hand: `trust proxy` is set to exactly one hop in
 * `http-server.factory.ts`, so Express takes the entry the operator's own proxy wrote and ignores
 * whatever a client prepended. The value is masked and hashed before it is stored, and it appears in
 * no log and in no response.
 */
const clientOf = (request: Request): SessionClient => ({
  userAgent: request.headers['user-agent'] ?? '',
  ipAddress: request.ip,
});

/**
 * The authentication endpoints: registration, sign-in, rotation and sign-out.
 *
 * Thin by construction — the validator has already run, one use-case is called, its result is
 * serialized — with exactly one thing happening here that happens nowhere else: **the refresh token
 * is moved from the use-case result into `Set-Cookie`**. It is never handed to a serializer, so no
 * response body can carry it (`auth.serializer.ts`).
 */
export const createAuthController = (
  dependencies: AuthControllerDependencies,
): {
  readonly register: RequestHandler;
  readonly login: RequestHandler;
  readonly refresh: RequestHandler;
  readonly logout: RequestHandler;
} => ({
  register: async (request, response) => {
    const { body } = dependencies.registerValidator.read(response);

    const result = await dependencies.register.execute({
      organization: body.organization,
      owner: {
        email: body.owner.email,
        password: body.owner.password,
        // Spread by hand rather than passed through, so an absent optional field stays absent
        // instead of becoming an explicit `undefined` the use-case would have to defend against.
        ...(body.owner.locale === undefined ? {} : { locale: body.owner.locale }),
        ...(body.owner.timezone === undefined ? {} : { timezone: body.owner.timezone }),
      },
      client: clientOf(request),
    });

    setRefreshCookie(response, result.session.refreshToken, result.session.refreshExpiresAt);
    response.status(201).json(
      serializeAuthenticatedSession({
        accessToken: result.session.accessToken,
        expiresInSeconds: result.session.expiresInSeconds,
        user: result.user,
        organization: result.organization,
      }),
    );
  },

  login: async (request, response) => {
    const { body } = dependencies.loginValidator.read(response);

    const result = await dependencies.login.execute({
      email: body.email,
      password: body.password,
      ...(body.organizationSlug === undefined ? {} : { organizationSlug: body.organizationSlug }),
      client: clientOf(request),
    });

    if (result.status === 'organization_selection_required') {
      // No session was issued, so no cookie is set — the conditional `Set-Cookie` of the contract.
      response.json(serializeOrganizationSelection(result.organizations));

      return;
    }

    setRefreshCookie(response, result.session.refreshToken, result.session.refreshExpiresAt);
    response.json(
      serializeAuthenticatedSession({
        accessToken: result.session.accessToken,
        expiresInSeconds: result.session.expiresInSeconds,
        user: result.user,
        organization: result.organization,
      }),
    );
  },

  refresh: async (request, response) => {
    const presented = readRefreshCookie(request);
    const result =
      presented === undefined
        ? null
        : await dependencies.refresh.execute({
            refreshToken: presented,
            client: clientOf(request),
          });

    if (result === null) {
      // Every refusal clears the cookie — expired, unknown, already spent, replayed — so a client
      // holding a token this server will never accept again stops presenting it instead of retrying
      // until the rate limiter answers. One branch, because the use-case has one refusal.
      clearRefreshCookie(response);

      throw new UnauthenticatedError();
    }

    setRefreshCookie(response, result.session.refreshToken, result.session.refreshExpiresAt);
    response.json(
      serializeAuthenticatedSession({
        accessToken: result.session.accessToken,
        expiresInSeconds: result.session.expiresInSeconds,
        user: result.user,
        organization: result.organization,
      }),
    );
  },

  /**
   * Signing out. The caller was established by the guard from **either** credential — that route
   * carries the cookie alternative precisely so that an expired access token cannot make it
   * impossible to close a session (`authenticate.middleware.ts`).
   */
  logout: async (_request, response) => {
    const caller = readCaller(response);

    await dependencies.endSession.signOut(
      { organizationId: caller.organizationId, userId: caller.userId },
      caller.sessionId,
    );

    clearRefreshCookie(response);
    response.status(204).end();
  },
});
