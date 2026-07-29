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

/**
 * `POST /auth/change-password`.
 *
 * Both fields carry `passwordSchema`, so the length policy is enforced on the *current* password
 * too. That looks redundant — the value either matches the stored digest or it does not — and it is
 * not: without it, a caller can send a one-megabyte string and have it verified against an Argon2id
 * digest, which is the cheapest half of the memory-exhaustion vector the limiter exists to close.
 *
 * "The new password equals the current one" is deliberately **not** a `.refine` here. It is refused
 * by the use-case, together with the strength policy, so the two answers come from one place and
 * both land on `newPassword` with one code (`change-password.use-case.ts`).
 */
export const changePasswordBodySchema = z.strictObject({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

export const forgotPasswordBodySchema = z.strictObject({
  email: emailSchema,
});

/**
 * The bounds `ResetPasswordRequest` publishes for the token.
 *
 * Thirty-two CSPRNG bytes are 43 base64url characters, so the lower bound is comfortably below what
 * this server mints and the upper one is there to stop a megabyte "token" from being hashed and
 * looked up. Both are deliberately loose: a schema tight enough to describe the exact format would
 * separate "not a token of ours" from "a token of ours that is not usable", and that is the one
 * distinction `password_reset_token_invalid` exists to hide.
 */
const RESET_TOKEN_MIN = 32;
const RESET_TOKEN_MAX = 512;

/**
 * `POST /auth/reset-password`, with the token in the **body**.
 *
 * Never a query parameter and never a path segment: a query string is written to the access log of
 * every proxy in front of the installation, is handed to the next origin in `Referer`, and is the
 * part of a URL people paste into support tickets. The emailed link carries it in a path segment of
 * the *SPA* route, and the browser turns it into this body, so the token never appears in a URL this
 * API sees. `test/contract/route-authorization.test.ts` refuses any path or query parameter whose
 * name looks like a credential, which is what keeps that true after this file.
 */
export const resetPasswordBodySchema = z.strictObject({
  token: z
    .string({ error: 'validation.token.invalid' })
    .min(RESET_TOKEN_MIN, { error: 'validation.token.invalid' })
    .max(RESET_TOKEN_MAX, { error: 'validation.token.invalid' }),
  newPassword: passwordSchema,
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
