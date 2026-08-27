import { SharedPermissions } from '@bad-crm/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type EmployeeProfilePatch,
  type EmployeeProfileRepositoryPort,
  type EmployeeProfileRow,
} from '@/application/iam/ports/employee-profile-repository.port.js';
import {
  ReadEmployeeProfileQuery,
  WriteEmployeeProfileUseCase,
} from '@/application/iam/use-cases/write-employee-profile.use-case.js';
import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { NotFoundError } from '@/domain/shared/errors/app.errors.js';

import { FakeUnitOfWork } from '../../support/identity-doubles.util.js';

/**
 * Editing and reading a personnel record.
 *
 * Three properties carry it, and none of them is about the fields themselves:
 *
 *   * **the emergency contact is encrypted before it reaches the repository** and decrypted only for
 *     a caller who may see it — a value that was never decrypted cannot be serialised or logged by
 *     mistake;
 *   * **the trail names the fields, never the values.** A contact in the audit log would undo the
 *     column being ciphertext;
 *   * **the cycle check reads inside the transaction that writes.** An answer obtained before it is
 *     an answer about a chart somebody else may have changed since.
 */

const ME = 'me';
const COLLEAGUE = 'colleague';

const actorWith = (granted: readonly string[], userId = ME): Actor => ({
  userId,
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set(granted as SharedPermissions.PermissionKey[]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
});

const row = (overrides: Partial<EmployeeProfileRow> = {}): EmployeeProfileRow => ({
  userId: ME,
  email: 'ivan@example.test',
  status: 'ACTIVE',
  firstName: 'Ivan',
  lastName: 'Petrov',
  jobTitle: null,
  department: null,
  managerId: null,
  weeklyCapacityHours: 40,
  employmentType: 'FULL_TIME',
  hiredAt: null,
  terminatedAt: null,
  timezone: 'UTC',
  skills: [],
  emergencyContactEnc: null,
  ...overrides,
});

class FakeProfiles implements EmployeeProfileRepositoryPort {
  readonly patches: { userId: string; patch: EmployeeProfilePatch }[] = [];

  constructor(
    private readonly state: {
      readonly stored?: EmployeeProfileRow | null;
      readonly links?: ReadonlyMap<string, string>;
      readonly missing?: boolean;
    } = {},
  ) {}

  byUserId(): Promise<EmployeeProfileRow | null> {
    return Promise.resolve('stored' in this.state ? this.state.stored : row());
  }

  upsert(userId: string, patch: EmployeeProfilePatch): Promise<EmployeeProfileRow | null> {
    this.patches.push({ userId, patch });

    if (this.state.missing === true) return Promise.resolve(null);

    return Promise.resolve(row({ userId, ...(patch as Partial<EmployeeProfileRow>) }));
  }

  managerLinks(): Promise<ReadonlyMap<string, string>> {
    return Promise.resolve(this.state.links ?? new Map());
  }
}

/** A stand-in that makes the ciphertext obvious: what is stored must not read as the plaintext. */
const fields = {
  encrypt: (value: string | null) => (value === null ? null : `v1:enc(${value})`),
  decrypt: (value: string | null) =>
    value === null ? null : value.replace(/^v1:enc\((.*)\)$/, '$1'),
};

let unitOfWork: FakeUnitOfWork;
let audit: { events: AuditEvent[]; port: { record: (event: AuditEvent) => Promise<void> } };

beforeEach(() => {
  unitOfWork = new FakeUnitOfWork();
  const events: AuditEvent[] = [];

  audit = {
    events,
    port: {
      record: (event: AuditEvent): Promise<void> => {
        events.push(event);

        return Promise.resolve();
      },
    },
  };
});

const write = (profiles: FakeProfiles): WriteEmployeeProfileUseCase =>
  new WriteEmployeeProfileUseCase(unitOfWork, profiles, fields, audit.port);

describe('editing a profile', () => {
  it('stores the emergency contact as ciphertext and hands the plaintext back', async () => {
    const profiles = new FakeProfiles();

    const visible = await write(profiles).execute({
      actor: actorWith([]),
      subjectUserId: ME,
      patch: { emergencyContact: 'sister, +7 900 000-00-00' },
    });

    // The plaintext crossed no boundary below the use-case.
    expect(profiles.patches[0]?.patch).toEqual({
      emergencyContactEnc: 'v1:enc(sister, +7 900 000-00-00)',
    });
    expect(JSON.stringify(profiles.patches)).not.toContain('+7 900 000-00-00, sister');
    expect(visible.emergencyContact).toBe('sister, +7 900 000-00-00');
  });

  it('records which fields changed and none of their values', async () => {
    const profiles = new FakeProfiles();

    await write(profiles).execute({
      actor: actorWith([]),
      subjectUserId: ME,
      patch: { firstName: 'Ivan', emergencyContact: 'sister, +7 900 000-00-00' },
    });

    expect(audit.events[0]).toMatchObject({
      action: 'employee.updated',
      after: { fields: ['firstName', 'emergencyContact'] },
    });
    expect(JSON.stringify(audit.events)).not.toContain('+7 900');
    expect(JSON.stringify(audit.events)).not.toContain('Ivan');
  });

  it('refuses an HR field on one’s own record without the capability, writing nothing', async () => {
    const profiles = new FakeProfiles();

    await expect(
      write(profiles).execute({
        actor: actorWith([]),
        subjectUserId: ME,
        patch: { weeklyCapacityHours: 80 },
      }),
    ).rejects.toBeInstanceOf(AccessRefusedError);
    expect(profiles.patches).toEqual([]);
    expect(unitOfWork.scopes).toEqual([]);
  });

  it('refuses a manager that would close a loop', async () => {
    // Ivan manages Pyotr; making Pyotr manage Ivan is the case the acceptance criterion names.
    const profiles = new FakeProfiles({ links: new Map([[COLLEAGUE, ME]]) });

    await expect(
      write(profiles).execute({
        actor: actorWith(['employee:update']),
        subjectUserId: ME,
        patch: { managerId: COLLEAGUE },
      }),
    ).rejects.toBeInstanceOf(AccessRefusedError);
    expect(profiles.patches).toEqual([]);
  });

  it('reads the chart inside the transaction that writes the edge', async () => {
    const profiles = new FakeProfiles();

    await write(profiles).execute({
      actor: actorWith(['employee:update']),
      subjectUserId: ME,
      patch: { managerId: COLLEAGUE },
    });

    // One scope for the read and the write: an answer obtained before the transaction is an answer
    // about a chart somebody else may have changed since.
    expect(unitOfWork.scopes).toEqual([{ organizationId: 'org-1', userId: ME }]);
    expect(profiles.patches[0]?.patch).toEqual({ managerId: COLLEAGUE });
  });

  it('answers 404 for a person of another organization', async () => {
    const profiles = new FakeProfiles({ missing: true });

    await expect(
      write(profiles).execute({
        actor: actorWith(['employee:update']),
        subjectUserId: COLLEAGUE,
        patch: { jobTitle: 'Engineer' },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(audit.events).toEqual([]);
  });
});

describe('reading a profile', () => {
  const read = (profiles: FakeProfiles): ReadEmployeeProfileQuery =>
    new ReadEmployeeProfileQuery(unitOfWork, profiles, fields);

  it('never decrypts for a caller who may not see it', async () => {
    // Not «decrypt and let the serializer drop it»: a value that was never decrypted cannot be
    // serialised, logged or snapshotted by mistake.
    const profiles = new FakeProfiles({
      stored: row({ userId: COLLEAGUE, emergencyContactEnc: 'v1:enc(sister)' }),
    });

    const visible = await read(profiles).execute({
      actor: actorWith(['employee:read']),
      subjectUserId: COLLEAGUE,
    });

    expect(visible.audience.personal).toBe(false);
    expect(visible.emergencyContact).toBeNull();
  });

  it('decrypts for the person themselves', async () => {
    const profiles = new FakeProfiles({ stored: row({ emergencyContactEnc: 'v1:enc(sister)' }) });

    const visible = await read(profiles).execute({ actor: actorWith([]), subjectUserId: ME });

    expect(visible.audience.personal).toBe(true);
    expect(visible.emergencyContact).toBe('sister');
  });

  it('refuses somebody else’s record without employee:read', async () => {
    await expect(
      read(new FakeProfiles()).execute({ actor: actorWith([]), subjectUserId: COLLEAGUE }),
    ).rejects.toBeInstanceOf(AccessRefusedError);
  });

  it('answers 404 when there is no such person here', async () => {
    await expect(
      read(new FakeProfiles({ stored: null })).execute({
        actor: actorWith(['employee:read']),
        subjectUserId: COLLEAGUE,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * The state of the account is resolved **here**, and refused here (STORY-012-09, D4 and D4-бис).
   *
   * The level is `employee:read`, or the record being one's own — the same barrier as reading
   * somebody else's record at all, so that the card and the directory row cannot disagree about one
   * person. On a **read** that makes the two coincide; on a **write** it does not, and that is what
   * the last two cases are: `employee:update` alone edits a colleague's record without being
   * allowed to read the state of their account, so the refusal is still reachable and still needed.
   *
   * `null` rather than «resolve it and let the serializer drop it», for the reason the emergency
   * contact is not decrypted for a caller who may not read it: a value that was never resolved
   * cannot be emitted, logged or snapshotted by mistake. The row keeps carrying the state either
   * way, so these cases are about what leaves this layer, not about what the repository returned.
   */
  describe('the state of the account', () => {
    const suspended = (userId: string): FakeProfiles =>
      new FakeProfiles({ stored: row({ userId, status: 'SUSPENDED' }) });

    it('is resolved for a colleague holding employee:read alone', async () => {
      // The caller D4-бис is about: the directory row already tells them this, so the card telling
      // them the same thing is the point of the decision.
      const visible = await read(suspended(COLLEAGUE)).execute({
        actor: actorWith(['employee:read']),
        subjectUserId: COLLEAGUE,
      });

      expect(visible.accountStatus).toBe('SUSPENDED');
    });

    it('is not bought by the personnel half, which is a different question', async () => {
      const profiles = suspended(COLLEAGUE);

      const visible = await read(profiles).execute({
        actor: actorWith(['employee:read', 'employee:view_personal_data']),
        subjectUserId: COLLEAGUE,
      });

      // The employment half arrived on its own permission, and the state on `employee:read`;
      // neither implies the other, which is why they are separate flags.
      expect(visible.audience.personal).toBe(true);
      expect(visible.accountStatus).toBe('SUSPENDED');
    });

    it('is resolved on one’s own record without any capability', async () => {
      const visible = await read(suspended(ME)).execute({
        actor: actorWith([]),
        subjectUserId: ME,
      });

      expect(visible.accountStatus).toBe('SUSPENDED');
    });

    it('is refused by an edit to a caller who may write the record but not read it', async () => {
      // `employee:update` without `employee:read` is a real caller — editing is not reading — so a
      // PATCH must not hand back as the reply to a rename what a GET would have refused.
      const profiles = new FakeProfiles();

      const visible = await write(profiles).execute({
        actor: actorWith(['employee:update']),
        subjectUserId: COLLEAGUE,
        patch: { jobTitle: 'Engineer' },
      });

      expect(visible.accountStatus).toBeNull();
      // CONTROL: the row does carry the state, so the `null` is the decision and not an empty write.
      expect(visible.profile.status).toBe('ACTIVE');
    });

    it('is resolved by an edit for a caller who may see it', async () => {
      const visible = await write(new FakeProfiles()).execute({
        actor: actorWith(['employee:update', 'employee:read']),
        subjectUserId: COLLEAGUE,
        patch: { jobTitle: 'Engineer' },
      });

      expect(visible.accountStatus).toBe('ACTIVE');
    });
  });
});
