import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type CapabilityFacts } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { PreviewProjectVisibilityQuery } from '@/application/project/use-cases/preview-project-visibility.query.js';
import { type ProjectRole } from '@/domain/project/project.enums.js';

import { FakeEffectivePermissionsReader } from '../../support/iam-doubles.util.js';
import { FakeClock } from '../../support/identity-doubles.util.js';
import {
  IVAN,
  OLGA,
  PETR,
  PROJECT_ID,
  SUSPENDED,
  actorWith,
  projectHarness,
  type ProjectHarness,
} from '../../support/project-harness.util.js';

/**
 * The summary of a visibility change (STORY-014-01, acceptance 7) — its order and its audience.
 *
 * What the domain table (`visibility-impact-policy.test.ts`) does not hold and this file does:
 * the command's decision is taken **before** the audience is read (a refused caller sends no read of
 * who is in the organization), the audience is the active accounts the reader brings — a suspended
 * one is not asked about even when capability facts exist for it — and each colleague is judged with
 * their own facts, not the caller's.
 */

const reads = (granted: readonly SharedPermissions.PermissionKey[]): CapabilityFacts => ({
  isOwner: false,
  granted,
  denied: [],
  roleKeys: ['developer'],
  permissionsVersion: 1,
});

const COLLEAGUE = reads(['project:read']);

const build = (
  seed: {
    readonly visibility?: 'PUBLIC_ORG' | 'PRIVATE';
    readonly isDeleted?: boolean;
    readonly members?: readonly (readonly [string, ProjectRole])[];
  } = {},
  byUser: Readonly<Record<string, CapabilityFacts | null>> = {},
): { readonly harness: ProjectHarness; readonly query: PreviewProjectVisibilityQuery } => {
  const harness = projectHarness({ members: [[IVAN, 'LEAD']], ...seed });

  // Olga holds VIEWER on the project itself: an explicit grant keeps her whatever the visibility.
  harness.store.audienceGrants.push({ userId: OLGA, depth: 0, level: 'VIEWER', expiresAt: null });

  return {
    harness,
    query: new PreviewProjectVisibilityQuery(
      harness.unitOfWork,
      harness.store,
      harness.acl,
      harness.store,
      new FakeEffectivePermissionsReader(COLLEAGUE, {
        [IVAN]: reads(['project:read', 'project:manage_visibility']),
        [SUSPENDED]: COLLEAGUE,
        ...byUser,
      }),
      new FakeClock(),
    ),
  };
};

const MANAGER = actorWith(['project:read', 'project:manage_visibility']);

describe('PreviewProjectVisibilityQuery', () => {
  it('closing a public project: the bystander loses it; the lead, a grant and a suspended account do not count', async () => {
    const { harness, query } = build();

    await expect(
      query.execute({ actor: MANAGER, projectId: PROJECT_ID, visibility: 'PRIVATE' }),
    ).resolves.toEqual({ losingAccess: 1, gainingAccess: 0 });

    // The decision first, the audience only after it.
    expect(harness.store.trace.indexOf('seatsOf')).toBeGreaterThan(
      harness.store.trace.indexOf('entriesAlong'),
    );
    expect(harness.store.trace).toContain('grantsOn');
  });

  it('opening a private project: the bystander gains it', async () => {
    const { query } = build({ visibility: 'PRIVATE' });

    await expect(
      query.execute({ actor: MANAGER, projectId: PROJECT_ID, visibility: 'PUBLIC_ORG' }),
    ).resolves.toEqual({ losingAccess: 0, gainingAccess: 1 });
  });

  it('judges each colleague by their own facts: one without project:read loses nothing', async () => {
    const { query } = build({}, { [PETR]: reads([]) });

    await expect(
      query.execute({ actor: MANAGER, projectId: PROJECT_ID, visibility: 'PRIVATE' }),
    ).resolves.toEqual({ losingAccess: 0, gainingAccess: 0 });
  });

  it('leaves out a colleague whose facts are gone by the time they are folded', async () => {
    const { query } = build({}, { [PETR]: null });

    await expect(
      query.execute({ actor: MANAGER, projectId: PROJECT_ID, visibility: 'PRIVATE' }),
    ).resolves.toEqual({ losingAccess: 0, gainingAccess: 0 });
  });

  it('moves nobody and reads no audience for the visibility already held', async () => {
    const { harness, query } = build();

    await expect(
      query.execute({ actor: MANAGER, projectId: PROJECT_ID, visibility: 'PUBLIC_ORG' }),
    ).resolves.toEqual({ losingAccess: 0, gainingAccess: 0 });
    expect(harness.store.trace).not.toContain('seatsOf');
  });

  it('refuses a caller without the key before anything about the project is read', async () => {
    const { harness, query } = build();

    await expect(
      query.execute({
        actor: actorWith(['project:read']),
        projectId: PROJECT_ID,
        visibility: 'PRIVATE',
      }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'permission_not_granted' });
    expect(harness.store.trace).toEqual([]);
  });

  it('refuses a holder of the key below MANAGER on the chain, and reads no audience', async () => {
    const { harness, query } = build({ members: [[IVAN, 'MEMBER']] });

    await expect(
      query.execute({ actor: MANAGER, projectId: PROJECT_ID, visibility: 'PRIVATE' }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'insufficient_acl_level' });
    expect(harness.store.trace).not.toContain('seatsOf');
  });

  it.each([
    ['a private project the caller is not on', { visibility: 'PRIVATE' as const, members: [] }],
    ['a deleted project', { isDeleted: true }],
  ])('answers %s as not there', async (_what, seed) => {
    const { harness, query } = build(seed);

    await expect(
      query.execute({ actor: MANAGER, projectId: PROJECT_ID, visibility: 'PUBLIC_ORG' }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
    expect(harness.store.trace).not.toContain('seatsOf');
  });
});
