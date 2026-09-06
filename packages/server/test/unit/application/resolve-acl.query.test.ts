import { describe, expect, it, vi } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import {
  type ProjectAccessReaderPort,
  type ProjectAclFacts,
} from '@/application/access/ports/project-access-reader.port.js';
import { ResolveAclQuery } from '@/application/access/use-cases/resolve-acl.query.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type AclChainNode, type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';

/**
 * The resolver: chain → entries → level, as one `AclScope` for `authorizeResource`.
 *
 * What is decided here and nowhere else is the **shape of the refusal** when the chain cannot be
 * built or read: `missing` for an object that is not there (a 404), `unavailable` for a reader that
 * failed (a 503). Neither is a level, and neither may become one — «resolve by the organization»
 * when the parent is gone is the fail-open STORY-011-06 acceptance 9 forbids.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-09-06T12:00:00Z');

const actorWith = (roleKeys: readonly string[] = ['developer']): Actor => ({
  userId: IVAN,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys,
});

class FakeAclReader implements AclReaderPort {
  readonly chains: (readonly AclChainNode[])[] = [];

  constructor(
    private readonly entries: readonly AclEntryOnChain[] = [],
    private readonly failure: Error | null = null,
  ) {}

  entriesAlong(chain: readonly AclChainNode[]): Promise<readonly AclEntryOnChain[]> {
    this.chains.push(chain);

    return this.failure === null ? Promise.resolve(this.entries) : Promise.reject(this.failure);
  }
}

class FakeProjectAccessReader implements ProjectAccessReaderPort {
  readonly asked: { projectId: string; userId: string }[] = [];

  constructor(
    private readonly facts: ProjectAclFacts | null,
    private readonly failure: Error | null = null,
  ) {}

  aclFacts(projectId: string, userId: string): Promise<ProjectAclFacts | null> {
    this.asked.push({ projectId, userId });

    return this.failure === null ? Promise.resolve(this.facts) : Promise.reject(this.failure);
  }
}

const logger = (): LoggerPort & { warnings: unknown[][] } => {
  const warnings: unknown[][] = [];
  const port: LoggerPort & { warnings: unknown[][] } = {
    warnings,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
    error: vi.fn(),
    child: () => port,
  };

  return port;
};

const query = (
  options: {
    entries?: readonly AclEntryOnChain[];
    readerFailure?: Error;
    projectFailure?: Error;
    project?: ProjectAclFacts | null;
  } = {},
): {
  query: ResolveAclQuery;
  reader: FakeAclReader;
  projects: FakeProjectAccessReader;
  log: ReturnType<typeof logger>;
} => {
  const reader = new FakeAclReader(options.entries ?? [], options.readerFailure ?? null);
  const projects = new FakeProjectAccessReader(
    options.project === undefined
      ? { organizationId: ORG, visibility: 'PRIVATE', memberRole: 'MEMBER' }
      : options.project,
    options.projectFailure ?? null,
  );
  const log = logger();

  return {
    query: new ResolveAclQuery({ acl: reader, projects, clock: { now: () => NOW }, logger: log }),
    reader,
    projects,
    log,
  };
};

describe('ResolveAclQuery — the project chain', () => {
  it('walks PROJECT → ORGANIZATION and reads the entries in one call', async () => {
    const { query: resolver, reader } = query();

    await resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT });

    expect(reader.chains).toEqual([
      [
        { depth: 0, type: 'PROJECT', id: PROJECT },
        { depth: 1, type: 'ORGANIZATION', id: ORG },
      ],
    ]);
  });

  it('answers the implicit level of the membership when the chain carries no entry', async () => {
    const { query: resolver } = query({
      project: { organizationId: ORG, visibility: 'PRIVATE', memberRole: 'REVIEWER' },
    });

    await expect(resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT })).resolves.toEqual({
      status: 'resolved',
      organizationId: ORG,
      level: 'COMMENTER',
      family: 'standard',
    });
  });

  it('lets an explicit entry on the project replace the membership level', async () => {
    const { query: resolver } = query({
      entries: [{ depth: 0, level: 'VIEWER', expiresAt: null }],
      project: { organizationId: ORG, visibility: 'PRIVATE', memberRole: 'MEMBER' },
    });

    await expect(
      resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT }),
    ).resolves.toMatchObject({ status: 'resolved', level: 'VIEWER' });
  });

  it('lets a grant on the organization reach a private project the person is not on', async () => {
    const { query: resolver } = query({
      entries: [{ depth: 1, level: 'EDITOR', expiresAt: null }],
      project: { organizationId: ORG, visibility: 'PRIVATE', memberRole: null },
    });

    await expect(
      resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT }),
    ).resolves.toMatchObject({ status: 'resolved', level: 'EDITOR' });
  });

  it('resolves NONE for a non-member of a private project — the 404 of acceptance 6', async () => {
    const { query: resolver } = query({
      project: { organizationId: ORG, visibility: 'PRIVATE', memberRole: null },
    });

    await expect(
      resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT }),
    ).resolves.toMatchObject({ status: 'resolved', level: 'NONE' });
  });

  it('applies the guest row before anything the chain says', async () => {
    const { query: resolver } = query({
      project: { organizationId: ORG, visibility: 'PUBLIC_ORG', memberRole: 'LEAD' },
    });

    await expect(
      resolver.resolve(actorWith(['guest']), { type: 'PROJECT', id: PROJECT }),
    ).resolves.toMatchObject({ status: 'resolved', level: 'NONE' });
  });

  it('applies expiry with the application clock', async () => {
    const { query: resolver } = query({
      entries: [{ depth: 0, level: 'MANAGER', expiresAt: new Date(NOW.getTime() - 1) }],
      project: { organizationId: ORG, visibility: 'PUBLIC_ORG', memberRole: null },
    });

    await expect(
      resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT }),
    ).resolves.toMatchObject({ status: 'resolved', level: 'VIEWER' });
  });

  it('asks the project reader about the actor, not about somebody else', async () => {
    const { query: resolver, projects } = query();

    await resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT });

    expect(projects.asked).toEqual([{ projectId: PROJECT, userId: IVAN }]);
  });
});

describe('ResolveAclQuery — the organization chain', () => {
  it('is one node, and the level is the implicit one unless an org-wide grant says otherwise', async () => {
    const { query: resolver, reader, projects } = query();

    await expect(resolver.resolve(actorWith(), { type: 'ORGANIZATION', id: ORG })).resolves.toEqual(
      {
        status: 'resolved',
        organizationId: ORG,
        level: 'VIEWER',
        family: 'standard',
      },
    );
    expect(reader.chains).toEqual([[{ depth: 0, type: 'ORGANIZATION', id: ORG }]]);
    expect(projects.asked).toEqual([]);
  });

  it('answers another organization as missing without reading anything', async () => {
    const { query: resolver, reader } = query();

    await expect(
      resolver.resolve(actorWith(), { type: 'ORGANIZATION', id: 'other-org' }),
    ).resolves.toEqual({
      status: 'missing',
    });
    expect(reader.chains).toEqual([]);
  });
});

describe('ResolveAclQuery — the refusals that are not levels', () => {
  it('answers a project that is not there as missing, reads no entries, and warns with the id', async () => {
    const { query: resolver, reader, log } = query({ project: null });

    await expect(resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT })).resolves.toEqual({
      status: 'missing',
    });
    expect(reader.chains).toEqual([]);
    expect(log.warnings).toEqual([
      [{ resourceType: 'PROJECT', resourceId: PROJECT }, 'acl chain broken: resource not found'],
    ]);
  });

  it('answers a reader that failed as unavailable — never a level — and warns', async () => {
    const failure = new Error('connection reset');
    const { query: resolver, log } = query({ readerFailure: failure });

    await expect(resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT })).resolves.toEqual({
      status: 'unavailable',
    });
    expect(log.warnings).toEqual([
      [{ resourceType: 'PROJECT', resourceId: PROJECT, err: failure }, 'acl resolution failed'],
    ]);
  });

  /**
   * The chain builder is a reader too — `projects.aclFacts` is a query — and its failure is the
   * same failure: «we could not check». Answering it with a 500 instead of the 503 the ACL reader
   * gets would make the two halves of one resolution disagree about what a timeout means.
   */
  it('answers a chain reader that failed as unavailable as well, reading no entries', async () => {
    const failure = new Error('statement timeout');
    const { query: resolver, reader, log } = query({ projectFailure: failure });

    await expect(resolver.resolve(actorWith(), { type: 'PROJECT', id: PROJECT })).resolves.toEqual({
      status: 'unavailable',
    });
    expect(reader.chains).toEqual([]);
    expect(log.warnings).toEqual([
      [{ resourceType: 'PROJECT', resourceId: PROJECT, err: failure }, 'acl resolution failed'],
    ]);
  });

  /**
   * A kind of object with no chain registered — every type but the two above, today. `unavailable`
   * rather than `missing`: the object may well exist, the server simply cannot answer about it, and
   * a 503 is the honest code for that (`rules/permissions.mdc`, 6). A `never` branch would have
   * been the alternative, and it is the wrong one here: the list of types is the database's and is
   * complete on purpose, while the list of chains grows one domain at a time.
   */
  it.each<SharedPermissions.AclResourceType>([
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
  ])('answers %s, which has no chain yet, as unavailable', async (type) => {
    const { query: resolver, reader, log } = query();

    await expect(resolver.resolve(actorWith(), { type, id: PROJECT })).resolves.toEqual({
      status: 'unavailable',
    });
    expect(reader.chains).toEqual([]);
    expect(log.warnings).toEqual([
      [{ resourceType: type, resourceId: PROJECT }, 'acl chain not registered for resource type'],
    ]);
  });
});
