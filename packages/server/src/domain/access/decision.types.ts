import { type SharedPermissions } from '@bad-crm/shared';

/**
 * The answer of the permission layer: allowed, or refused **with a reason**.
 *
 * The shape is the one `docs/security/permission-model.md` §7 declares, and the discriminant makes
 * the two halves impossible to confuse: an allowed decision carries `reason: null`, so a call site
 * cannot read a reason off a decision it never checked.
 *
 * A boolean was the alternative and it is the wrong one. The reason is the difference between «you
 * are missing permission X» and «you have no access to this object» — two sentences with different
 * remedies in the interface, two different rows in the audit trail, and, when support has to answer
 * «why can they not do this», the difference between a minute and an afternoon.
 */
export type Decision =
  | { readonly allowed: true; readonly reason: null }
  | {
      readonly allowed: false;
      readonly reason: SharedPermissions.DenyReason;
      /**
       * The key the refusal was about, when the refusal was about a key at all.
       *
       * Optional because most refusals are not: a last owner, a closed period and a system role are
       * states, not capabilities, and inventing a key for them would put a value into the trail that
       * no catalogue entry backs. It is carried rather than re-derived because the one place that
       * knows it — `authorizeCapability`, which was handed the key — is several layers below the one
       * that needs it, and the alternative is the transport guessing from an error code.
       *
       * What needs it: the denial trail records a refusal on a `dangerous` key **whatever** the
       * request method (`domain/access/denied-access-audit.policy.ts`), and «is this key dangerous»
       * is a question only the key answers.
       */
      readonly permissionKey?: SharedPermissions.PermissionKey;
    };
