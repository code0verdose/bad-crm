import { type Organization } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { toOrganizationSummary } from '@/infrastructure/persistence/prisma/organization-row.util.js';

/**
 * The boundary Prisma types are not allowed to cross (rules/hexagonal-backend.mdc, rule 4).
 *
 * The assertion that matters is the negative one: a row carries columns the application layer has
 * no business reading, and a mapper written as a spread would carry them along — putting
 * `settings: Prisma.JsonValue` into a port's contract and `deletedAt` into a response serializer's
 * reach. Listing the fields is the point; this test is what makes the listing hold.
 */
describe('toOrganizationSummary', () => {
  const row: Organization = {
    id: '018f4a3b-0000-7000-8000-000000000001',
    slug: 'acme',
    name: 'Acme',
    ownerId: '018f4a3b-0000-7000-8000-000000000002',
    timezone: 'Europe/Berlin',
    defaultCurrency: 'EUR',
    settings: { theme: 'dark' },
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-02T00:00:00Z'),
    deletedAt: null,
  };

  it('takes the fields the application layer is allowed to see', () => {
    expect(toOrganizationSummary(row)).toEqual({
      id: '018f4a3b-0000-7000-8000-000000000001',
      slug: 'acme',
      name: 'Acme',
      timezone: 'Europe/Berlin',
      defaultCurrency: 'EUR',
    });
  });

  it('leaves the bookkeeping columns behind', () => {
    expect(Object.keys(toOrganizationSummary(row)).sort()).toEqual([
      'defaultCurrency',
      'id',
      'name',
      'slug',
      'timezone',
    ]);
  });
});
