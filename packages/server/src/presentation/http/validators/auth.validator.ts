import { emailSchema, passwordSchema, slugSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The request schemas of the authentication surface, one per body the contract declares.
 *
 * `strictObject` throughout, matching `additionalProperties: false` in `docs/api/openapi.yaml`: an
 * endpoint that quietly ignores an unknown field is how a client ships `organization_slug` against
 * an operation that reads `organizationSlug`, gets a 200, and finds out in production.
 *
 * The primitives come from `packages/shared` so that the client enforces the same rule before the
 * round trip — `emailSchema` trims and lower-cases, `passwordSchema` carries the length policy,
 * `slugSchema` normalises case and whitespace (rules/zod-validation.mdc, §1).
 */

const ORGANIZATION_NAME_MAX = 120;

export const registerBodySchema = z.strictObject({
  organization: z.strictObject({
    name: z
      .string({ error: 'validation.organization.name.invalid' })
      .trim()
      .min(1, { error: 'validation.organization.name.invalid' })
      .max(ORGANIZATION_NAME_MAX, { error: 'validation.organization.name.too_long' }),
    slug: slugSchema,
  }),
  owner: z.strictObject({
    email: emailSchema,
    password: passwordSchema,
    locale: z.string().min(2).max(16).optional(),
    timezone: z.string().min(1).max(64).optional(),
  }),
});

export const loginBodySchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  organizationSlug: slugSchema.optional(),
});

export const sessionIdParamsSchema = z.strictObject({
  sessionId: z.uuid({ error: 'validation.id.invalid' }),
});

/**
 * `POST /auth/refresh`, `POST /auth/logout` and `POST /auth/sessions/revoke-others` take no body.
 *
 * Declared rather than omitted, for the same reason `metaQuerySchema` is: an operation that accepts
 * a body it does not read is an operation whose contract nobody can rely on. `undefined` is allowed
 * because `express.json()` leaves the property unset when the request carries no payload at all.
 */
export const noBodySchema = z.union([z.strictObject({}), z.undefined()]);

export type RegisterBody = z.output<typeof registerBodySchema>;
export type LoginBody = z.output<typeof loginBodySchema>;
