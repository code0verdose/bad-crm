import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { RESOLVABLE_ACL_RESOURCE_TYPES } from '@/application/access/resolvable-acl-resource-types.constant.js';

import { readOpenApiDocument, schemaEnum } from './openapi-document.util.js';

/**
 * The kinds of object `/acl` accepts, as the contract publishes them and as the server resolves them.
 *
 * Three lists that must agree in a particular way. The server's resolvable list keys the resolver's
 * registry of chains and whitelists `resourceType` in `acl.validator.ts`, so it cannot drift from
 * either — but the `AclResourceType` enum in `openapi.yaml` is written by hand (ADR-0003), and the day
 * a domain adds its chain without widening the enum, the generated client refuses to compile a call
 * the server would answer, or the other way round: a kind in the enum the server answers `422`.
 * The third list is the table's: every resolvable kind must also be a kind `resource_acl` stores.
 */
describe('the object kinds of /acl', () => {
  it('are published exactly as the server resolves them', () => {
    const published = schemaEnum(readOpenApiDocument(), 'AclResourceType');

    expect([...published].sort()).toEqual([...RESOLVABLE_ACL_RESOURCE_TYPES].sort());
  });

  it('are kinds the table stores — never a kind of their own', () => {
    expect(
      RESOLVABLE_ACL_RESOURCE_TYPES.filter(
        (type) => !(SharedPermissions.ACL_RESOURCE_TYPES as readonly string[]).includes(type),
      ),
    ).toEqual([]);
  });

  it('CONTROL: the list is not empty, so the comparisons above compare something', () => {
    expect(RESOLVABLE_ACL_RESOURCE_TYPES.length).toBeGreaterThan(0);
  });
});
