import { SharedPermissions } from '@bad-crm/shared';

import {
  type EffectivePermissionsReaderPort,
  type HeldRole,
  type OverrideFacts,
} from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  canInspectPermissions,
  INSPECT_PERMISSIONS_KEY,
} from '@/domain/iam/access/permission-inspection.policy.js';
import { refusalResourceOf } from '@/domain/access/refusal-resource.util.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

/**
 * One permission of one person: what the answer is, and which layer produced it.
 *
 * `allowed` and `source` are not two facts. `source` is the rung of the capability ladder that
 * answered, and `allowed` is `sourceAllows` of it — the derivation asserted over every shape of view
 * in `packages/shared/test/permissions/capability-source.test.ts`. They cannot disagree, because
 * there is nothing for them to disagree about.
 *
 * `roleIds` is reported **whatever the source is**, and that is what makes the three-state control
 * on screen honest: switching an exception back to «inherited» has to show what the person will fall
 * back to, and «inherited from nothing» and «inherited from Manager» are different futures. A
 * response that only mentioned roles when a role happened to win could not tell them apart.
 */
export interface PermissionState {
  readonly key: SharedPermissions.PermissionKey;
  readonly allowed: boolean;
  readonly source: SharedPermissions.CapabilitySource;
  readonly roleIds: readonly string[];
  readonly override: OverrideFacts | null;
}

/**
 * Every permission of one person, with its origin — the answer the administration screen renders.
 *
 * **Capability only: layers 1–3.** `allowed` here means «this person may do this somewhere in the
 * organization», not «this person may do this to that object». For the keys that carry a
 * `requiredLevel` the object half is still ahead of them, and this endpoint has no object to apply
 * it to. Answering the narrower question is `permission:explain` — a different key, a different
 * operation, and one that needs `ResourceAcl` to exist first (STORY-011-06, blocked on EPIC-014).
 * The client knows which keys those are: it holds the same catalogue.
 *
 * Every key of the catalogue is present, including the ones nobody granted. The alternative — omit
 * them and let the client read absence as refusal — moves one rule of the permission model into the
 * client, and «absent means denied» is exactly the kind of rule that survives until somebody
 * paginates the array.
 */
export interface UserPermissions {
  readonly userId: string;
  readonly isOwner: boolean;
  readonly version: number;
  readonly roles: readonly HeldRole[];
  readonly permissions: readonly PermissionState[];
}

export interface GetUserPermissionsInput {
  readonly actor: Actor;
  readonly subjectUserId: string;
}

/**
 * What somebody else may do, and who arranged it.
 *
 * The counterpart of `GET /me/permissions`, which takes no subject on purpose: an operation whose
 * authorization depends on an argument is the shape that produces «forgot to check for this value».
 * So reading another person is a different route with a capability of its own,
 * `permission:override_read`, checked here through `canInspectPermissions` — the guard on the route
 * is a fail-fast, and this is the authority (invariant 2 of CLAUDE.md).
 *
 * **The order of the two refusals is the whole of the 403/404 rule.** The capability is decided
 * first, so a caller without it is refused 403 whether the id they sent belongs to a colleague, to
 * another organization, or to nobody — the endpoint answers nothing about who exists. Only a caller
 * who may read gets as far as the reader, and for them an id outside the tenant is 404, because
 * inside their own organization the existence of a colleague is not a secret while the membership of
 * another tenant always is.
 *
 * The 403 is coded through `refusalResourceOf`, the same function the route guard uses, so that the
 * refusal reads identically whichever layer produced it. A capability refusal is a refusal by the
 * *organization* — the check asks whether the caller may do this anywhere in it, with no object
 * involved — which is why it is not `user_forbidden` even though the request named a person.
 *
 * **Nothing here decides anything about permissions.** The rung is
 * `SharedPermissions.capabilitySource`, which refines the same `capabilityOutcome` the guard walks;
 * this class supplies the attribution the folded view drops and does no reasoning of its own. That
 * is deliberate to the point of pedantry: a screen that explained the permission model with its own
 * copy of the permission model would be wrong precisely when an administrator turns to it.
 *
 * **A successful read files `permission.inspected`, `INFO`.** `docs/security/permission-model.md`
 * §10 does not audit an ordinary `GET`, and this one is the named exception rather than a quiet
 * departure from it: the body carries the sentences an administrator wrote about a named colleague
 * under `reason`, and reading it across the roster draws the map of how the organization is actually
 * administered — the same two properties that put `audit.exported`, `vault.escrow_used` and
 * `VaultAccessLog`'s own `VIEW` on the trail.
 *
 * **Only the branch that returns an answer is recorded, and the other branch is recorded nowhere.**
 * An earlier version of this comment justified that by §10 «already logging a denial on a
 * `dangerous` key» — it does not. No refusal action exists in `AUDIT_ACTIONS`; `assertAllowed` below
 * runs **before** `withTenant` and before `audit.record`, and the route guard refuses earlier still,
 * so there is no point on the refusal path where an entry could be written today. A caller without
 * `permission:override_read` enumerating user ids leaves only an HTTP log line — actor, route
 * template, 403 — with no subject and no key. Auditing refusals is EPIC-016; this is a known gap,
 * not a rule enforced elsewhere.
 */
export class GetUserPermissionsQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly permissions: EffectivePermissionsReaderPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: GetUserPermissionsInput): Promise<UserPermissions> {
    assertAllowed(canInspectPermissions(input.actor), refusalResourceOf(INSPECT_PERMISSIONS_KEY));

    return await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const attributed = await this.permissions.attributedCapabilitiesOf(input.subjectUserId);

        if (attributed === null) throw denyAccess('user', 'other_organization');

        const view: SharedPermissions.CapabilityView = {
          isOwner: attributed.facts.isOwner,
          permissions: new Set(attributed.facts.granted),
          denied: new Set(attributed.facts.denied),
        };

        const allowedByOverride = new Set<SharedPermissions.PermissionKey>(
          [...attributed.overrides]
            .filter(([, override]) => override.effect === 'ALLOW')
            .map(([key]) => key),
        );

        const result: UserPermissions = {
          userId: input.subjectUserId,
          isOwner: attributed.facts.isOwner,
          version: attributed.facts.permissionsVersion,
          roles: attributed.roles,
          permissions: SharedPermissions.PERMISSIONS.map((key) => {
            const source = SharedPermissions.capabilitySource(view, key, allowedByOverride);

            return {
              key,
              allowed: SharedPermissions.sourceAllows(source),
              source,
              roleIds: attributed.grantedByRole.get(key) ?? [],
              override: attributed.overrides.get(key) ?? null,
            };
          }),
        };

        await this.audit.record({
          action: 'permission.inspected',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'USER', id: input.subjectUserId },
          requestId: undefined,
        });

        return result;
      },
    );
  }
}
