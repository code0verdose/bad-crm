import { SharedValidation } from '@bad-crm/shared';
import { z } from 'zod';

/**
 * Who the tab is signed in as, read off an `AuthenticatedSession` answer.
 *
 * A schema rather than a cast, because this is a boundary: the generated types promise
 * `format: uuid` and cannot enforce it, and the two fields end up as branded ids in query keys and
 * in tenant-scoped requests. «A string that came back» is not the same claim as «a user id».
 *
 * It takes the **whole answer**, not two fields picked out of it. Reading `session.user.id` before
 * validating assumes the shape of a body that may not have one — a proxy's error page, a truncated
 * response — and crashes on the assumption instead of reporting «this is not a session». `safeParse`
 * at the call site turns any of that into «no session», which is a state the application already
 * knows what to do with.
 *
 * Deliberately absent from the output: the access token. It goes to
 * `auth-token-storage.util.ts` and appears in no type anything else can hold (CLAUDE.md,
 * «Чувствительность данных»).
 */
export const sessionIdentitySchema = z
  .object({
    user: z.object({ id: SharedValidation.userIdSchema }),
    organization: z.object({ id: SharedValidation.organizationIdSchema }),
  })
  .transform(({ user, organization }) => ({
    userId: user.id,
    organizationId: organization.id,
  }));

export type SessionIdentity = z.output<typeof sessionIdentitySchema>;
