/**
 * Why a change was refused, in words the screen can show — the codes the preview answers with.
 *
 * Its own file rather than a corner of the domain labels: two unrelated maps under one name is how
 * a file stops being findable by what it holds (`rules/naming-and-structure.mdc` §D).
 */
export const ROLE_CHANGE_REFUSAL_KEY: Readonly<Record<string, string>> = {
  system_role_immutable: 'roles.refusal.systemRole',
  permission_not_granted: 'roles.refusal.notGranted',
  // Reachable since the preview started asking for the capability to save: somebody with `role:read`
  // and a DENY override on `role:update` sees this rather than the generic fallback.
  denied_by_override: 'roles.refusal.deniedByOverride',
  self_lockout: 'roles.refusal.selfLockout',
};
