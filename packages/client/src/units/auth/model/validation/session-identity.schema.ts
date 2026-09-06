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
    /**
     * The organization's second-factor policy, as it applies to **this** session (STORY-013-05).
     *
     * Both are absent for an ordinary session rather than `false` and `null`, and the schema keeps
     * them that way: the server states presence, and a client that read `mfaEnrollment === false`
     * would be reading a field the contract does not promise. `.optional()` here, and the transform
     * below spreads them only when they are there, so the two facts stay «said» or «not said».
     *
     * A timestamp rather than a duration, because a grace period is days long and the answer that
     * carries it is refreshed at most every fifteen minutes.
     *
     * `.catch(undefined)` on both, and that is about what a failure costs rather than about
     * tolerance. This object is the **whole** session answer: a `safeParse` failure clears the access
     * token and signs the tab out. A timestamp an older or newer server spells with an offset instead
     * of `Z` is a banner that cannot be drawn — not a reason to end somebody's session over it.
     */
    mfaEnrollment: z.literal(true).optional().catch(undefined),
    mfaGraceEndsAt: z.iso.datetime().optional().catch(undefined),
  })
  .transform(({ user, organization, mfaEnrollment, mfaGraceEndsAt }) => ({
    userId: user.id,
    organizationId: organization.id,
    ...(mfaEnrollment === undefined ? {} : { mfaEnrollment }),
    ...(mfaGraceEndsAt === undefined ? {} : { mfaGraceEndsAt }),
  }));

export type SessionIdentity = z.output<typeof sessionIdentitySchema>;
