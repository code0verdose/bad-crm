import { type TxClient } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Invalidates the cached view of rights of a set of people — one statement, however many.
 *
 * The counter travels in the access token and is compared with the row on every request, so a
 * change of rights takes effect on the next request rather than on the next sign-in. It is bumped
 * in the same transaction as the change; bumped after, a request in flight can still be answered
 * with the old rights and no trace of why.
 *
 * Shared by the team repository (a disband, a roster change) and the ACL repository (a grant to
 * a team reaches everyone on it): the same `UPDATE … WHERE id = ANY($n::uuid[])`, written once.
 * The tenant predicate is stated although the policy would apply it, so the statement reads as
 * scoped in the log and cannot lose its scope by a policy edit.
 */
export const bumpPermissionsVersionOf = async (
  tx: TxClient,
  organizationId: string,
  userIds: readonly string[],
): Promise<void> => {
  if (userIds.length === 0) return;

  await tx.$executeRaw`
    UPDATE users
       SET permissions_version = permissions_version + 1
     WHERE organization_id = ${organizationId}::uuid
       AND id = ANY(${[...userIds]}::uuid[])`;
};
