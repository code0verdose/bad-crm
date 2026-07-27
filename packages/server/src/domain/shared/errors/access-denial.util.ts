import { type ErrorResource } from '@bad-crm/shared/errors';

import { ForbiddenError, NotFoundError, type AppError } from './app.errors.js';

/**
 * Why access was denied — the only input that decides between 404 and 403.
 *
 * `other_organization` covers both "belongs to another tenant" and "we could not even establish
 * that it exists in this one": from outside, those are indistinguishable, and they must stay that
 * way.
 */
export type AccessDenialScope = 'own_organization' | 'other_organization';

/**
 * Invariant 2 of CLAUDE.md, as a function.
 *
 * A denial that crosses organizations is answered **404**, not 403 — otherwise the API becomes an
 * oracle telling an attacker which ids exist in tenants they cannot see. 403 is reserved for a
 * denial inside the caller's own organization, where the existence of the resource is not a secret.
 *
 * The rule is enforced by making compliance the shorter path: policies and use-cases state the
 * scope of the denial and receive the correct error, instead of choosing a status themselves. The
 * mapping is tested once here rather than re-reviewed at every call site.
 */
export const denyAccess = (resource: ErrorResource, scope: AccessDenialScope): AppError =>
  scope === 'other_organization'
    ? new NotFoundError(`${resource}_not_found`)
    : new ForbiddenError(`${resource}_forbidden`);
