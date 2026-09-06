import { describe, expect, it } from 'vitest';

import {
  ACL_RESOURCE_FAMILY,
  ACL_RESOURCE_TYPES,
  ACL_SUBJECT_TYPES,
  isAclResourceType,
  isAclSubjectType,
} from '../../src/permissions/acl-subject.enums.js';

/**
 * The two ends of a `ResourceAcl` row, as `docs/architecture/data-model.md` lists them.
 *
 * Written out rather than derived, on purpose: each value mirrors a label of a PostgreSQL enum,
 * and an enum label cannot be dropped without recreating the type — so a change here has to show
 * up as a failing test somebody reads, not as a diff nobody did.
 */
describe('ACL resource types', () => {
  it('lists exactly the twelve types of the polymorphic-access table', () => {
    expect([...ACL_RESOURCE_TYPES]).toEqual([
      'ORGANIZATION',
      'PROJECT',
      'BOARD',
      'TASK',
      'DOC_PAGE',
      'KB_SPACE',
      'KB_NOTE',
      'FILE',
      'FILE_FOLDER',
      'CHANNEL',
      'VAULT',
      'DASHBOARD',
    ]);
  });

  it.each([...ACL_RESOURCE_TYPES])('recognises %s', (type) => {
    expect(isAclResourceType(type)).toBe(true);
  });

  it.each(['project', 'Project', 'SECURE_LINK', ''])('refuses %j', (value) => {
    expect(isAclResourceType(value)).toBe(false);
  });

  it('places the vault, and only the vault, outside the owner bypass', () => {
    const vaultLike = ACL_RESOURCE_TYPES.filter((type) => ACL_RESOURCE_FAMILY[type] === 'vault');

    expect(vaultLike).toEqual(['VAULT']);
  });
});

describe('ACL subject types', () => {
  it('names a person, a role and a team — the three subjects of layer 4', () => {
    expect([...ACL_SUBJECT_TYPES]).toEqual(['USER', 'ROLE', 'TEAM']);
  });

  it.each([...ACL_SUBJECT_TYPES])('recognises %s', (type) => {
    expect(isAclSubjectType(type)).toBe(true);
  });

  it.each(['GROUP', 'user', ''])('refuses %j', (value) => {
    expect(isAclSubjectType(value)).toBe(false);
  });
});
