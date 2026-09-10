import { type SharedPermissions } from '@bad-crm/shared';

import { ResolveAclQuery } from '@/application/access/use-cases/resolve-acl.query.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type ProjectRole } from '@/domain/project/project.enums.js';

import {
  FakeAuditLogger,
  FakeClock,
  FakeUnitOfWork,
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  RecordingLogger,
} from './identity-doubles.util.js';
import { FakeProjectStore } from './project-doubles.util.js';

/** The ids every project use-case suite reasons about. Uuids, because the store keys on them as ids. */
export const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';
export const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';
export const PETR = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b12';
export const OLGA = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b13';
export const SUSPENDED = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b14';
export const ADDRESS = '203.0.113.4';

export const actorWith = (
  granted: readonly SharedPermissions.PermissionKey[],
  overrides: Partial<Actor> = {},
): Actor => ({
  userId: IVAN,
  organizationId: ORGANIZATION_ID,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(granted),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: ['developer'],
  ...overrides,
});

export interface ProjectHarness {
  readonly store: FakeProjectStore;
  readonly unitOfWork: FakeUnitOfWork;
  readonly audit: FakeAuditLogger;
  readonly acl: ResolveAclQuery;
}

/**
 * The project use-cases over one store, one unit of work and the real resolver — the same
 * composition `auth-app.util.ts` mounts under HTTP, without the HTTP.
 *
 * The resolver is the real `ResolveAclQuery` over the store rather than a double answering a level,
 * so «Ivan is a `MEMBER`, therefore `EDITOR`» is the implicit table's own reading and a suite here
 * cannot seed a level the roster contradicts. Three accounts are seeded as subjects: Ivan (the
 * caller), Petr and Olga (active), plus one suspended account.
 */
export const projectHarness = (
  seed: {
    readonly visibility?: 'PUBLIC_ORG' | 'PRIVATE';
    readonly status?: 'ACTIVE' | 'ON_HOLD' | 'ARCHIVED' | 'CLOSED';
    readonly isDeleted?: boolean;
    readonly organizationId?: string;
    readonly members?: readonly (readonly [string, ProjectRole])[];
  } = {},
): ProjectHarness => {
  const unitOfWork = new FakeUnitOfWork();
  const store = new FakeProjectStore().bindTo(unitOfWork);

  store.seed({
    projectId: PROJECT_ID,
    organizationId: seed.organizationId ?? ORGANIZATION_ID,
    visibility: seed.visibility ?? 'PUBLIC_ORG',
    status: seed.status ?? 'ACTIVE',
    isDeleted: seed.isDeleted ?? false,
    leadId: PETR,
    name: 'Bad CRM',
    description: 'The product itself',
  });

  for (const [userId, role] of seed.members ?? []) store.addMember(PROJECT_ID, userId, role);

  store.subjects.set(IVAN, { userId: IVAN, status: 'ACTIVE' });
  store.subjects.set(PETR, { userId: PETR, status: 'ACTIVE' });
  store.subjects.set(OLGA, { userId: OLGA, status: 'ACTIVE' });
  store.subjects.set(SUSPENDED, { userId: SUSPENDED, status: 'SUSPENDED' });

  return {
    store,
    unitOfWork,
    audit: new FakeAuditLogger(),
    acl: new ResolveAclQuery({
      acl: store,
      projects: store,
      clock: new FakeClock(),
      logger: new RecordingLogger(),
    }),
  };
};

/** A read of the store the way every adapter reads it — inside the caller's tenant scope. */
export const inTenant = <T>(harness: ProjectHarness, work: () => Promise<T>): Promise<T> =>
  harness.unitOfWork.withTenant({ organizationId: ORGANIZATION_ID, userId: IVAN }, work);

export { ORGANIZATION_ID, OTHER_ORGANIZATION_ID };
