import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type Actor } from '@/domain/access/actor.types.js';
import {
  assertLastLeadKept,
  assertNotSelfJoin,
  assertProjectSubjectJoinable,
} from '@/domain/project/access/project-membership.policy.js';
import { type ProjectSubject } from '@/domain/project/project.entity.js';
import { ConflictError, NotFoundError } from '@/domain/shared/errors/app.errors.js';

/**
 * The three rules of a project roster that are neither capability nor level — STORY-014-02,
 * acceptance 6, 7 and 8 — table-driven per `rules/testing.mdc`, 2.
 *
 * **Nobody puts themselves on a project**, whatever key they hold (`T-PROJ-02`): the right to
 * manage a roster is the right over other people, and a lead who wants to be on their own project
 * already is. **The last lead stays**: a project with no `LEAD` has nobody with `MANAGER` on it by
 * membership, and the way out is to appoint another lead first. **A suspended account joins
 * nothing**, and *which* inactive state it is in is told only to a caller who may read the directory
 * — the same L-1 the team policy applies, for the same reason.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PETR = '018f4a3b-0000-7000-8000-0000000000c2';

const actorWith = (granted: readonly SharedPermissions.PermissionKey[] = []): Actor => ({
  userId: IVAN,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(granted),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: ['developer'],
});

const subject = (overrides: Partial<ProjectSubject> = {}): ProjectSubject => ({
  userId: PETR,
  status: 'ACTIVE',
  ...overrides,
});

const thrown = (work: () => void): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }

  return undefined;
};

describe('assertNotSelfJoin', () => {
  it('CONTROL: adding somebody else is not a self-join', () => {
    expect(() => {
      assertNotSelfJoin(actorWith(['project:manage_members']), PETR);
    }).not.toThrow();
  });

  it('refuses the caller’s own id as a 403 inside the contour, even with the key', () => {
    const error = thrown(() => {
      assertNotSelfJoin(actorWith(['project:manage_members']), IVAN);
    });

    expect(error).toMatchObject({
      code: 'project_forbidden',
      reason: 'self_assignment_forbidden',
      permissionKey: 'project:manage_members',
    });
  });
});

describe('assertLastLeadKept', () => {
  it.each<[string, readonly string[], string]>([
    ['CONTROL: two leads, one leaves', [IVAN, PETR], IVAN],
    ['CONTROL: the person leaving is not a lead at all', [IVAN], PETR],
    ['CONTROL: no leads on record — nothing to keep', [], PETR],
  ])('%s', (_case, leads, leaving) => {
    expect(() => {
      assertLastLeadKept(leads, leaving);
    }).not.toThrow();
  });

  it('refuses to let the only lead go, as a conflict with a next step', () => {
    const error = thrown(() => {
      assertLastLeadKept([IVAN], IVAN);
    });

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe('last_project_lead_required');
  });
});

describe('assertProjectSubjectJoinable', () => {
  it('CONTROL: an active account of this organization may join', () => {
    expect(() => {
      assertProjectSubjectJoinable(actorWith(['project:manage_members']), subject());
    }).not.toThrow();
  });

  /** 404 rather than 403: another organization's account and no account at all are one answer. */
  it('answers 404 for an account the repository could not see', () => {
    const error = thrown(() => {
      assertProjectSubjectJoinable(actorWith(['project:manage_members']), null);
    });

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).code).toBe('user_not_found');
  });

  it.each(['SUSPENDED', 'INVITED'] as const)(
    'refuses a %s account with a conflict, for a caller who may also read the directory',
    (status) => {
      const error = thrown(() => {
        assertProjectSubjectJoinable(
          actorWith(['project:manage_members', 'user:read']),
          subject({ status }),
        );
      });

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe('member_not_active');
    },
  );

  it.each(['SUSPENDED', 'INVITED'] as const)(
    'answers 404, not 409, for a %s account when the caller may not read the directory',
    (status) => {
      const error = thrown(() => {
        assertProjectSubjectJoinable(actorWith(['project:manage_members']), subject({ status }));
      });

      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).code).toBe('user_not_found');
    },
  );
});
