import { type Request, type RequestHandler } from 'express';

import { type ChangePasswordUseCase } from '@/application/identity/use-cases/change-password.use-case.js';
import { type ConfirmPasswordResetUseCase } from '@/application/identity/use-cases/confirm-password-reset.use-case.js';
import { type EndSessionUseCase } from '@/application/identity/use-cases/end-session.use-case.js';
import { type SessionClient } from '@/application/identity/use-cases/issue-session.use-case.js';
import { type LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { type RefreshSessionUseCase } from '@/application/identity/use-cases/refresh-session.use-case.js';
import { type RegisterOrganizationUseCase } from '@/application/identity/use-cases/register-organization.use-case.js';
import { type RequestPasswordResetUseCase } from '@/application/identity/use-cases/request-password-reset.use-case.js';
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
  type changePasswordBodySchema,
  type forgotPasswordBodySchema,
  type loginBodySchema,
  type registerBodySchema,
  type resetPasswordBodySchema,
} from '@/presentation/http/validators/auth.validator.js';

export interface AuthControllerDependencies {
  readonly register: RegisterOrganizationUseCase;
  readonly login: LoginUseCase;
  readonly refresh: RefreshSessionUseCase;
  readonly endSession: EndSessionUseCase;
  readonly changePassword: ChangePasswordUseCase;
  readonly requestPasswordReset: RequestPasswordResetUseCase;
  readonly confirmPasswordReset: ConfirmPasswordResetUseCase;
  readonly registerValidator: RequestValidator<{ body: typeof registerBodySchema }>;
  readonly loginValidator: RequestValidator<{ body: typeof loginBodySchema }>;
  readonly changePasswordValidator: RequestValidator<{ body: typeof changePasswordBodySchema }>;
  readonly forgotPasswordValidator: RequestValidator<{ body: typeof forgotPasswordBodySchema }>;
  readonly resetPasswordValidator: RequestValidator<{ body: typeof resetPasswordBodySchema }>;
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
  readonly changePassword: RequestHandler;
  readonly forgotPassword: RequestHandler;
  readonly resetPassword: RequestHandler;
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

  /**
   * Changing one's own password.
   *
   * The two values the use-case may not take from the body are taken from the caller the guard
   * established: **whose** password this is, and **which** session survives. A `userId` or a
   * `sessionId` in the request would be a way to change somebody else's password and a way to
   * choose which device stays signed in — and the second one is the more interesting of the two,
   * because it is the intruder's obvious move.
   *
   * No cookie is touched and no token is issued: the current session is untouched by design, so
   * the access token in the caller's memory stays valid (`docs/api/openapi.yaml`).
   */
  changePassword: async (request, response) => {
    const caller = readCaller(response);
    const { body } = dependencies.changePasswordValidator.read(response);

    await dependencies.changePassword.execute({
      actor: { organizationId: caller.organizationId, userId: caller.userId },
      currentFamilyId: caller.familyId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      client: clientOf(request),
    });

    response.status(204).end();
  },

  /**
   * Asking for a reset link.
   *
   * **202 and an empty body, always** — there is nowhere for the difference between "sent" and
   * "not sent" to appear, which is the point of answering with no body at all. The handler does not
   * branch: the use-case either completes or raises, and the only failure it raises is one that
   * depends on the installation rather than on the address (`docs/api/openapi.yaml`).
   */
  forgotPassword: async (request, response) => {
    const { body } = dependencies.forgotPasswordValidator.read(response);

    await dependencies.requestPasswordReset.execute({
      email: body.email,
      client: clientOf(request),
    });

    response.status(202).end();
  },

  /**
   * Spending a reset link.
   *
   * No cookie is set and no token is returned: a session minted from something that sat in a
   * mailbox would be a session minted from a mailbox. The client sends the person to `/login`.
   */
  resetPassword: async (request, response) => {
    const { body } = dependencies.resetPasswordValidator.read(response);

    await dependencies.confirmPasswordReset.execute({
      token: body.token,
      newPassword: body.newPassword,
      client: clientOf(request),
    });

    response.status(204).end();
  },
});
