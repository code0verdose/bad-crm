import { z } from 'zod';

/**
 * The bounds `ClientErrorReport` publishes, enforced.
 *
 * Every maximum here is the same argument: a report becomes a line in a log, and a log line whose
 * length the caller chooses is a disk the caller can fill. The endpoint is unauthenticated by
 * design, so «the caller» includes anybody who can reach the port.
 *
 * `strictObject` rather than a permissive one: a field nobody declared is a field nobody reviewed,
 * and this body is written straight into the log.
 */
export const clientErrorBodySchema = z.strictObject({
  message: z.string().min(1).max(512),
  stack: z.string().max(8192).optional(),
  appVersion: z.string().min(1).max(32),
  route: z.string().max(256),
  reference: z.string().min(4).max(64),
  requestId: z.string().max(64).optional(),
});

export type ClientErrorBody = z.infer<typeof clientErrorBodySchema>;
