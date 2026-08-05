import { SharedPermissions } from '@bad-crm/shared';
import { ERROR_RESOURCES } from '@bad-crm/shared/errors';
import { describe, expect, it } from 'vitest';

import { refusalResourceOf } from '@/domain/access/refusal-resource.util.js';

/**
 * Every permission in the catalogue can be refused, and the refusal has a code a client can read.
 *
 * The two catalogues are deliberately different sizes — `ERROR_RESOURCES` lists what the client has
 * a translated sentence for, `PERMISSION_META[...].resource` names every noun the product has a
 * permission about — so the mapping is total by construction rather than by coincidence. Walked over
 * the whole catalogue here, which is the assertion the utility's own comment promises: a key whose
 * resource stops resolving fails a test instead of producing `undefined_forbidden` at runtime.
 */

const KNOWN = new Set<string>(ERROR_RESOURCES);

describe('the resource a capability refusal is coded as', () => {
  it('answers with a translatable resource for every permission in the catalogue', () => {
    const unresolved = SharedPermissions.PERMISSIONS.filter(
      (permission) => !KNOWN.has(refusalResourceOf(permission)),
    );

    expect(unresolved).toEqual([]);
  });

  it('uses the permission’s own resource when the client can translate it', () => {
    expect(refusalResourceOf('role:assign')).toBe('role');
    expect(refusalResourceOf('task:update')).toBe('task');
  });

  /**
   * The other branch, and it is not a fallback in disguise: a capability check asks whether the
   * caller may do this *anywhere in this organization*, with no object involved — so a refusal at
   * that layer is a refusal by the organization. `mail` and `acl` are nouns with permissions and no
   * error vocabulary, which is what makes them the honest examples here.
   */
  it('answers «organization» for a noun the error catalogue does not carry', () => {
    expect(KNOWN.has('mail')).toBe(false);
    expect(refusalResourceOf('mail:create_account')).toBe('organization');
    expect(refusalResourceOf('acl:grant')).toBe('organization');
  });

  it('CONTROL: the catalogue it walks is not empty', () => {
    expect(SharedPermissions.PERMISSIONS.length).toBeGreaterThan(300);
  });
});
