import { describe, expect, it } from 'vitest';

import { type AclListEntry } from '@/application/access/ports/acl-repository.port.js';
import { serializeResourceAclEntry } from '@/presentation/http/serializers/acl.serializer.js';

/**
 * The grant on the wire is a whitelist: a field the read model grows for a policy or a trail must
 * not reach a response by default. `toEqual` refuses any key the serializer does not name, so the
 * extra field planted below would fail this test the day a spread replaced the field list.
 */

const entry = {
  id: '018f4a3b-0000-7000-8000-0000000000f1',
  resource: { type: 'PROJECT', id: '018f4a3b-0000-7000-8000-0000000000d1' },
  subject: { type: 'TEAM', id: '018f4a3b-0000-7000-8000-0000000000e1' },
  level: 'EDITOR',
  expiresAt: new Date('2026-12-31T00:00:00.000Z'),
  grantedById: '018f4a3b-0000-7000-8000-0000000000c2',
  grantedAt: new Date('2026-09-06T12:00:00.000Z'),
} as const satisfies AclListEntry;

describe('serializeResourceAclEntry', () => {
  it('names every field of ResourceAclEntry and nothing else', () => {
    const withInternal = { ...entry, organizationId: '018f4a3b-0000-7000-8000-0000000000a1' };

    expect(serializeResourceAclEntry(withInternal)).toEqual({
      id: entry.id,
      resourceType: 'PROJECT',
      resourceId: entry.resource.id,
      subjectType: 'TEAM',
      subjectId: entry.subject.id,
      accessLevel: 'EDITOR',
      expiresAt: '2026-12-31T00:00:00.000Z',
      grantedById: entry.grantedById,
      grantedAt: '2026-09-06T12:00:00.000Z',
    });
  });

  it('keeps an open-ended grant and a grant whose grantor left as null', () => {
    expect(
      serializeResourceAclEntry({ ...entry, expiresAt: null, grantedById: null }),
    ).toMatchObject({ expiresAt: null, grantedById: null });
  });
});
