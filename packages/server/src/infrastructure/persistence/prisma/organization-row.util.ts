import { type Organization } from '@prisma/client';

import { type OrganizationSummary } from '@/application/organization/ports/organization-repository.port.js';

/**
 * `organizations` row → the read model the application layer sees.
 *
 * A module of its own rather than a private method, because its purpose is a boundary: no Prisma
 * type may leave `infrastructure/persistence` (rules/hexagonal-backend.mdc, rule 4). Returning the
 * row directly would type `application` against the generated client — every column rename would
 * then reach a use-case, and `settings: Prisma.JsonValue` would become part of a port's contract.
 *
 * It is also a filter. The row carries columns nothing outside this layer has any business reading
 * (`deletedAt`, `settings`, the timestamps); adding a field here is a decision, whereas spreading
 * the row is a decision nobody makes.
 */
export const toOrganizationSummary = (row: Organization): OrganizationSummary => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  timezone: row.timezone,
  defaultCurrency: row.defaultCurrency,
});
