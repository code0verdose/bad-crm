import { userIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * `POST /users/{userId}/reset-mfa`.
 *
 * No body: `user:reset_mfa` is `dangerous`, and the confirmation STORY-013-04's acceptance 10 asks
 * for is a client-side dialog naming the consequences — the same choice this codebase already made
 * for `user:suspend` (`deactivateUserBodySchema` also carries no confirmation flag; only a reason,
 * which a reset has none of, unlike an offboarding). `userId` is the only input, and it comes from
 * the path, never the body — the same rule `mfa.validator.ts` states for the self-service surface,
 * applied here to the administrative one.
 */
export const resetUserMfaParamsSchema = z.strictObject({ userId: userIdSchema });
