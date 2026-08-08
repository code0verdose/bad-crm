import {
  type EmployeeProfilePatch,
  type EmployeeProfileRepositoryPort,
  type EmployeeProfileRow,
} from '@/application/iam/ports/employee-profile-repository.port.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Employee profiles through Prisma, inside the scope the caller opened.
 *
 * **The emergency contact is ciphertext on both sides of this class.** It arrives encrypted and
 * leaves encrypted; the use-case decrypts it at the moment of use, and only for a caller who may see
 * it. A repository that decrypted would put the plaintext in every read of this table — including
 * the ones that never needed it, which is most of them.
 */
export class PrismaEmployeeProfileRepository
  extends TenantScopedRepository
  implements EmployeeProfileRepositoryPort
{
  protected readonly resource = 'user' as const;
  protected readonly repositoryName = 'EmployeeProfileRepository';

  /**
   * The profile of one person, or `null` when **the account** is not in this organization.
   *
   * An account with no profile row yet is an **empty** profile, not a 404. Somebody who accepted an
   * invitation this morning has no row until an administrator fills the form in, and answering «not
   * found» to their own `/employees/me` would say the person does not exist — which is the sentence
   * 404 is reserved for on this endpoint, and the one tenancy depends on. Nothing is written here:
   * the row appears when somebody actually edits something.
   */
  byUserId(userId: string): Promise<EmployeeProfileRow | null> {
    return this.run('byUserId', async (tx) => {
      const organizationId = this.organizationId('byUserId');
      const account = await tx.user.findFirst({
        where: { organizationId, id: userId, deletedAt: null },
        select: { email: true, employeeProfile: true },
      });

      if (account === null) return null;

      return account.employeeProfile === null
        ? emptyRow(userId, account.email)
        : toRow({ ...account.employeeProfile, user: { email: account.email } });
    });
  }

  upsert(userId: string, patch: EmployeeProfilePatch): Promise<EmployeeProfileRow | null> {
    return this.run('upsert', async (tx) => {
      const organizationId = this.organizationId('upsert');

      // The account has to exist here before its profile can: the composite foreign key would refuse
      // anyway, and answering before it does is what lets the caller say 404 rather than translate a
      // constraint violation.
      const account = await tx.user.findFirst({
        where: { organizationId, id: userId, deletedAt: null },
        select: { email: true },
      });

      if (account === null) return null;

      // One statement rather than «read, then insert or update»: the row is created by two different
      // paths — accepting an invitation, and the first time an administrator fills the form in — and
      // reading first would let the two race into `uq_employee_profiles_user`.
      const profile = await tx.employeeProfile.upsert({
        where: { organizationId_userId: { organizationId, userId } },
        create: {
          organizationId,
          userId,
          // Required columns with no value in the patch: a profile created by an edit that only set
          // a job title still needs a name, and an empty string is the honest «not filled in yet»
          // rather than a guess at what the person is called.
          firstName: patch.firstName ?? '',
          lastName: patch.lastName ?? '',
          ...definedOnly(patch),
        },
        update: definedOnly(patch),
        include: { user: { select: { email: true } } },
      });

      return toRow(profile);
    });
  }

  managerLinks(): Promise<ReadonlyMap<string, string>> {
    return this.run('managerLinks', async (tx) => {
      const links = await tx.employeeProfile.findMany({
        where: { organizationId: this.organizationId('managerLinks'), managerId: { not: null } },
        select: { userId: true, managerId: true },
      });

      return new Map(
        links.flatMap((link) => (link.managerId === null ? [] : [[link.userId, link.managerId]])),
      );
    });
  }
}

/**
 * Drops the keys the patch did not carry.
 *
 * Prisma treats an explicit `undefined` as «leave it alone», so this is not strictly required for
 * `update` — but it is for `create`, where an `undefined` on a column with a default would still
 * override the default with nothing. Doing it once means the two halves of the upsert cannot
 * disagree.
 */
const definedOnly = (patch: EmployeeProfilePatch): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      // `skills` arrives `readonly` and Prisma wants a mutable array; copying it here keeps the
      // widening in one place instead of at every call site.
      .map(([key, value]) => [key, key === 'skills' ? [...(value as readonly string[])] : value]),
  );

/** What a person looks like before anybody has filled anything in. Not stored — computed on read. */
const emptyRow = (userId: string, email: string): EmployeeProfileRow => ({
  userId,
  email,
  firstName: '',
  lastName: '',
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
});

const toRow = (profile: {
  readonly userId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly managerId: string | null;
  readonly weeklyCapacityHours: number;
  readonly employmentType: string;
  readonly hiredAt: Date | null;
  readonly terminatedAt: Date | null;
  readonly timezone: string;
  readonly skills: string[];
  readonly emergencyContactEnc: string | null;
  readonly user: { readonly email: string };
}): EmployeeProfileRow => ({
  userId: profile.userId,
  email: profile.user.email,
  firstName: profile.firstName,
  lastName: profile.lastName,
  jobTitle: profile.jobTitle,
  department: profile.department,
  managerId: profile.managerId,
  weeklyCapacityHours: profile.weeklyCapacityHours,
  employmentType: profile.employmentType,
  hiredAt: profile.hiredAt,
  terminatedAt: profile.terminatedAt,
  timezone: profile.timezone,
  skills: profile.skills,
  emergencyContactEnc: profile.emergencyContactEnc,
});
