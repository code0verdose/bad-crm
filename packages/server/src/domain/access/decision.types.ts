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
  | { readonly allowed: false; readonly reason: SharedPermissions.DenyReason };
