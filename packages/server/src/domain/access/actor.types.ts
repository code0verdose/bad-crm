import { type SharedPermissions } from '@bad-crm/shared';

/**
 * Who is asking, folded into the shape a decision needs — and nothing else.
 *
 * It extends `CapabilityView` from `packages/shared` rather than restating it: that interface is
 * what the pure `can()` takes, and the client imports the same one for UI hints. Two structurally
 * similar types would drift the moment one of them gained a field.
 *
 * Deliberately **not** the user row. No email, no name, no status: an actor is the answer to «what
 * may this caller do», and a policy that could read a profile would sooner or later decide something
 * by it — which is the second point of authorization the model exists to forbid.
 *
 * `permissionsVersion` is here for one purpose: it travels in the access token, and the session
 * layer compares it with the row to decide whether a folded view may still be trusted. A role change
 * therefore takes effect on the next request instead of on the next login.
 */
export interface Actor extends SharedPermissions.CapabilityView {
  readonly userId: string;
  readonly organizationId: string;
  readonly permissionsVersion: number;
}
