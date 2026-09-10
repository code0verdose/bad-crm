import { projectIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The request schemas of the project surface.
 *
 * `projectId` is the shared branded uuid, and it is refused at the boundary for the reason every
 * other id parameter is: `scope()` casts it with `::uuid` inside the transaction, so a value that is
 * not one would raise in PostgreSQL and be answered `500` — an invitation to retry something that
 * can never succeed. `422` at the edge is the honest answer, and it says nothing about existence.
 */
export const projectIdParamsSchema = z.strictObject({ projectId: projectIdSchema });
