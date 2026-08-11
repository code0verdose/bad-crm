import { userIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The address of «somebody else's permissions»: a person, and nothing else.
 *
 * `strictObject` like every other schema here — it covers the path, which is all this operation
 * takes. There is deliberately **no** query schema: the answer is the whole catalogue, the client
 * holds the same catalogue and filters against it, and every other parameterless GET in the registry
 * is declared the same way. An undeclared query parameter is therefore ignored rather than refused,
 * which `user-permissions-endpoints.test.ts` pins down — the failure mode worth ruling out is not a
 * tolerated parameter but a *narrowed* body answering as if it were whole. When this endpoint learns
 * to narrow, it will do so because a schema says it may.
 */
export const userPermissionsParamsSchema = z.strictObject({ userId: userIdSchema });
