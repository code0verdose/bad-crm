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
/**
 * A segment that looks like a value rather than a name.
 *
 * Sixteen characters of the opaque alphabet — the shape a token has and a route name does not.
 * `/reset-password` and `/admin/members` are words with hyphens; `qngiI0B_xib-WOQDvNwdgaqM0sBklxeR`
 * is a credential. The rule is deliberately about shape and not about a list of known routes: this
 * process has no register of the client's route tree, and keeping a copy of one here would be a
 * second definition drifting from the first.
 *
 * The bound is a judgement, and a cheap one to revisit: no route name in this product comes close
 * to sixteen characters without a hyphen or a slash, and no token this product mints is shorter.
 */
const OPAQUE_SEGMENT = /(^|\/)[A-Za-z0-9_-]{16,}(\/|$)/;

/**
 * Why the server checks this at all, when the client already sends a template.
 *
 * Because the client sending one is a property of the shipped client, and this endpoint is
 * unauthenticated by design: «the caller» is anybody who can reach the port. And the shipped client
 * *was* the accident — until 2026-08-28 it sent `location.pathname`, so a failed password reset
 * reported its own token into the application log, against the invariant that a URL which is itself
 * a credential is never logged (`rules/observability.mdc`). A guarantee held on one side of the wire
 * is a guarantee against mistakes, not against use.
 */
const routeTemplate = z
  .string()
  .max(256)
  .refine((route) => !OPAQUE_SEGMENT.test(route), {
    error:
      'route must be a route template (`/reset-password/$token`), not the address that was open: ' +
      'a segment this long and this opaque is a value, and values are credentials here',
  });

export const clientErrorBodySchema = z.strictObject({
  message: z.string().min(1).max(512),
  stack: z.string().max(8192).optional(),
  appVersion: z.string().min(1).max(32),
  route: routeTemplate,
  reference: z.string().min(4).max(64),
  requestId: z.string().max(64).optional(),
});

export type ClientErrorBody = z.infer<typeof clientErrorBodySchema>;
