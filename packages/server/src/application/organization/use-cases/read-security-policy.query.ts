import { type SharedOrganization } from '@bad-crm/shared';

import { type MfaPolicyQuery } from '@/application/organization/use-cases/mfa-policy.query.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';

/**
 * The organization's stored security policy, for the administration screen to edit.
 *
 * Its own query rather than a field of some larger organization read, because the capability that
 * gates it is its own: `organization:manage_security_policy` is `dangerous` and held by `owner` and
 * `admin`, while `organization:read` is held by everybody. Folding the policy into the general
 * organization read would hand every account the list of roles that must carry a second factor —
 * which is a map of where the weak accounts are.
 */
export class ReadSecurityPolicyQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly policies: MfaPolicyQuery,
  ) {}

  execute(actor: Actor): Promise<SharedOrganization.SecurityPolicy> {
    return this.unitOfWork.withTenant(
      { organizationId: actor.organizationId, userId: actor.userId },
      () => this.policies.policy(),
    );
  }
}
