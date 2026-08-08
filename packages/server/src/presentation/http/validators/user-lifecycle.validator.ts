import { userIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The request schemas of deactivation and reactivation.
 *
 * The reason is **required** on the way out and absent on the way back. Offboarding is the entry an
 * incident review reads first, and «switched off, no reason given» is the line that costs an hour of
 * asking around; coming back needs no such note, because the account being on is its own explanation.
 */
export const userLifecycleParamsSchema = z.strictObject({ userId: userIdSchema });

export const deactivateUserBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});
