import { describe, expect, it } from 'vitest';

import { SharedPermissions } from '@bad-crm/shared';
import { ERROR_RESOURCES } from '@bad-crm/shared/errors';

import {
  errorResourceOfAclResource,
  errorResourceOfAclSubject,
} from '@/domain/access/acl-error-resource.util.js';

/**
 * Which translated sentence a refusal about an ACL object or subject is coded as.
 *
 * Total by construction: both maps are `Record`s over the closed lists, so a type added to either
 * list without a sentence does not compile. What the test adds is that every answer is a resource
 * the client can actually phrase, and that the two lists are walked in full — a map that stops
 * compiling is loud, a map that maps to a code nobody translated is not.
 */
describe('errorResourceOfAclResource', () => {
  it.each([...SharedPermissions.ACL_RESOURCE_TYPES])(
    '%s maps to a resource the client translates',
    (type) => {
      expect(ERROR_RESOURCES).toContain(errorResourceOfAclResource(type));
    },
  );

  it('keeps the two kinds that exist today on their own sentences', () => {
    expect(errorResourceOfAclResource('ORGANIZATION')).toBe('organization');
    expect(errorResourceOfAclResource('PROJECT')).toBe('project');
  });
});

describe('errorResourceOfAclSubject', () => {
  it.each([...SharedPermissions.ACL_SUBJECT_TYPES])(
    '%s maps to a resource the client translates',
    (type) => {
      expect(ERROR_RESOURCES).toContain(errorResourceOfAclSubject(type));
    },
  );

  it('names the subject, not the object: a missing team is team_not_found', () => {
    expect(errorResourceOfAclSubject('USER')).toBe('user');
    expect(errorResourceOfAclSubject('ROLE')).toBe('role');
    expect(errorResourceOfAclSubject('TEAM')).toBe('team');
  });
});
