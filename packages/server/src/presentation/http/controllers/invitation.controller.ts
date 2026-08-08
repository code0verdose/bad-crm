import { type RequestHandler } from 'express';

import { type ListInvitationsQuery } from '@/application/iam/use-cases/list-invitations.query.js';
import {
  type CreateInvitationUseCase,
  type ResendInvitationUseCase,
  type RevokeInvitationUseCase,
} from '@/application/iam/use-cases/write-invitation.use-case.js';
import { type AcceptInvitationUseCase } from '@/application/iam/use-cases/accept-invitation.use-case.js';
import { clientOf } from '@/presentation/http/session-client.util.js';
import { readActor } from '@/presentation/http/middleware/require-permission.middleware.js';
import { setRefreshCookie } from '@/presentation/http/refresh-cookie.util.js';
import { serializeAuthenticatedSession } from '@/presentation/http/serializers/auth.serializer.js';
import { type RequestValidator } from '@/presentation/http/middleware/validate.middleware.js';
import {
  serializeInvitation,
  serializeMintedInvitation,
} from '@/presentation/http/serializers/invitation.serializer.js';
import { type acceptInvitationBodySchema } from '@/presentation/http/validators/accept-invitation.validator.js';
import {
  type createInvitationBodySchema,
  type invitationIdParamsSchema,
} from '@/presentation/http/validators/invitation.validator.js';

export interface InvitationControllerDependencies {
  readonly listInvitations: ListInvitationsQuery;
  readonly createInvitation: CreateInvitationUseCase;
  readonly resendInvitation: ResendInvitationUseCase;
  readonly revokeInvitation: RevokeInvitationUseCase;
  readonly acceptInvitation: AcceptInvitationUseCase;
  readonly createValidator: RequestValidator<{ body: typeof createInvitationBodySchema }>;
  readonly invitationIdValidator: RequestValidator<{ params: typeof invitationIdParamsSchema }>;
  readonly acceptValidator: RequestValidator<{ body: typeof acceptInvitationBodySchema }>;
}

/**
 * Inviting somebody, re-issuing the link and closing it early.
 *
 * The handlers are wiring. Who may invite whom — the subset rule of `T-IAM-09`, the accepted
 * invitation that may not be re-issued, the address that already has an account — is decided by
 * `invitation-access.policy.ts` from inside the use-cases, which is where invariant 2 of CLAUDE.md
 * requires the authoritative check to be.
 *
 * Creating and re-issuing both answer with the **link**, and it is the only moment it exists: the
 * row carries a digest, so nothing can produce this URL a second time. Revoking answers 204 — the
 * row is gone, and there is nothing left to describe.
 */
export const createInvitationController = (
  dependencies: InvitationControllerDependencies,
): {
  readonly list: RequestHandler;
  readonly create: RequestHandler;
  readonly resend: RequestHandler;
  readonly revoke: RequestHandler;
  readonly accept: RequestHandler;
} => ({
  list: async (_request, response) => {
    const invitations = await dependencies.listInvitations.execute({
      actor: readActor(response),
    });

    response.status(200).json({ items: invitations.map(serializeInvitation) });
  },

  create: async (_request, response) => {
    const { body } = dependencies.createValidator.read(response);

    const minted = await dependencies.createInvitation.execute({
      actor: readActor(response),
      email: body.email,
      // `null` and «absent» mean the same thing — no role — and the schema allows both because a
      // client that clears the field sends `null` while one that never set it omits the key.
      roleId: body.roleId ?? null,
      teamIds: body.teamIds ?? [],
      locale: body.locale,
    });

    response.status(201).json(serializeMintedInvitation(minted));
  },

  resend: async (_request, response) => {
    const { params } = dependencies.invitationIdValidator.read(response);

    const minted = await dependencies.resendInvitation.execute({
      actor: readActor(response),
      invitationId: params.invitationId,
    });

    // 200 rather than 201: the invitation already existed, and what changed is the credential on it.
    response.status(200).json(serializeMintedInvitation(minted));
  },

  /**
   * The one handler of this surface with no session behind it: the token in the body **is** the
   * credential. It answers with the same document sign-in does, and sets the same refresh cookie —
   * the person is signed in the moment their account exists, because a screen that said «account
   * created, now sign in» would ask them to type a password they chose four seconds ago.
   */
  accept: async (request, response) => {
    const { body } = dependencies.acceptValidator.read(response);

    const accepted = await dependencies.acceptInvitation.execute({
      token: body.token,
      password: body.password,
      locale: body.locale,
      // A browser without full ICU reports no zone at all, and `UTC` is a correct answer in its own
      // right — the same default the column carries.
      timezone: body.timezone ?? 'UTC',
      client: clientOf(request),
    });

    setRefreshCookie(response, accepted.session.refreshToken, accepted.session.refreshExpiresAt);
    response.status(201).json(
      serializeAuthenticatedSession({
        accessToken: accepted.session.accessToken,
        expiresInSeconds: accepted.session.expiresInSeconds,
        user: accepted.user,
        organization: accepted.organization,
      }),
    );
  },

  revoke: async (_request, response) => {
    const { params } = dependencies.invitationIdValidator.read(response);

    await dependencies.revokeInvitation.execute({
      actor: readActor(response),
      invitationId: params.invitationId,
    });

    response.status(204).send();
  },
});
