import { AUDIT_ACTIONS, type AuditAction } from './audit-action.enums.js';

/**
 * How loudly an entry reads. Same three levels as the column
 * (`docs/security/permission-model.md` §10, «Что логируется всегда»).
 */
export const AUDIT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/**
 * The severity of an action, decided once per action rather than per call site.
 *
 * The document assigns severity to the *action*, not to the moment: «role.assigned» is a `warning`
 * wherever it is raised, and an ownership transfer is `critical` even when it is routine. Leaving it
 * to the caller would produce the failure that makes a severity column useless — the same event
 * filed at two levels depending on which use-case raised it, so a filter on «show me the critical
 * ones» silently misses half of them.
 *
 * `Record<AuditAction, …>` is what keeps it complete: an action added to the catalogue with no level
 * here does not compile.
 */
export const AUDIT_ACTION_SEVERITY: Readonly<Record<AuditAction, AuditSeverity>> = {
  /**
   * `WARNING`, and the level is what makes the registration atomic — not the place the record is
   * written from. Creating a tenant is the one event without which the trail of an installation
   * cannot be read: every later entry names an organization, and this is the entry that says who
   * created it and when. It was `INFO` until 2026-09-10 on the reading «the ordinary start of
   * everything, loud only in aggregate» — and `INFO` behind no key is exactly the class the writer
   * may degrade (`degradable-audit-actions.util.ts`): the insert was fenced in a savepoint, the
   * failure swallowed one layer up, and an organization committed with no record of who created
   * it, while the use-case's docstring promised the opposite. A promise made by a call site was
   * only as good as the severity underneath it. At `WARNING` the degradation is forbidden by
   * construction — a failed row aborts the transaction that is creating the tenant, and the
   * registration is refused rather than left unexplained. Same level as `invitation.accepted`:
   * a person entering the trail, and this is the person who opened it.
   */
  'organization.registered': 'WARNING',
  'session.signed_in': 'INFO',
  // A session ending is routine; the interesting version of it — a family revoked because a token
  // was replayed — is the separate `session.refresh_reuse_detected` entry below.
  'session.revoked': 'INFO',
  // `CRITICAL`, alongside `user.mfa_reset_by_admin`, `role.dangerous_granted`,
  // `organization.ownership_transferred` and `rls.bypassed`: a refresh token presented after it was
  // already spent, outside the rotation-race window, is evidence a stolen token is being used right
  // now — not a report that an account *was* compromised, a signal that it is being compromised at
  // this moment, while every device on the family is still live. An installation that alerts on the
  // other four should alert on this one at least as urgently: it is the one entry in this list that
  // an incident review would rather have caught before the attacker's first request than after it.
  'session.refresh_reuse_detected': 'CRITICAL',
  // A credential changed: the event an incident review starts from when an account behaves oddly.
  'password.changed': 'WARNING',
  // Same, and reachable by whoever holds a mailbox rather than the old password.
  'password.reset': 'WARNING',
  // A second factor was switched on: the event an incident review wants to find, because its absence
  // is the difference between a leaked password being a minor and a total compromise.
  'user.mfa_enabled': 'WARNING',
  // Enrolment reset itself after five wrong codes. Not critical — nothing was granted or taken away —
  // but the same level as `password.changed`: it is where an incident review starts when an account
  // is later found compromised, because a stranger holding the password would produce exactly this.
  'user.mfa_setup_failed': 'WARNING',
  // A recovery code, not a TOTP code, opened the session: the alternate credential that exists
  // specifically for "I no longer have my authenticator" was exercised. Worth a reviewer's attention
  // even when nothing else about the sign-in is unusual, which is what `WARNING` buys here.
  'user.mfa_recovery_code_used': 'WARNING',
  // The same level as `user.mfa_setup_failed`, and for the same reason: nothing was granted or taken
  // away, but a run of wrong recovery codes is where an incident review starts when the account is
  // later found compromised — it is what somebody working through a stolen sheet of codes looks like.
  'user.mfa_recovery_locked_out': 'WARNING',
  // The whole recovery-code set was replaced. Same level as a permission override: it is a change to
  // what can get somebody back into the account, made after the stronger reauthentication check.
  'user.mfa_recovery_codes_regenerated': 'WARNING',
  // Same level as enabling: losing the second factor is exactly as significant an event as gaining
  // one, and it is the entry an incident review reaches for when an account that had 2FA no longer
  // does.
  'user.mfa_disabled': 'WARNING',
  // `CRITICAL`, unlike the self-service disable above: somebody other than the account owner just
  // removed their second factor and revoked every one of their sessions. An installation that alerts
  // on `organization.ownership_transferred` and `rls.bypassed` should alert on this one too — it is
  // the step that immediately precedes an account takeover if the actor's own credentials are not
  // what they claim to be.
  'user.mfa_reset_by_admin': 'CRITICAL',
  // What a role grants is what everybody holding it may do: the composition is a change of rights
  // for a group rather than for a person, which is why it reads at the same level as an assignment.
  'role.created': 'WARNING',
  'role.updated': 'WARNING',
  'role.deleted': 'WARNING',
  // Storing a dangerous key is the escalation an organization reviews, whoever was entitled to do
  // it: `user:impersonate` in a role is one assignment away from being somebody else.
  'role.dangerous_granted': 'CRITICAL',
  // Who may do what changed. `warning` because it is the event an escalation review starts from:
  // §10 of the permission model files every change of rights at this level.
  'role.assigned': 'WARNING',
  'role.revoked': 'WARNING',
  // An invitation is a role assignment written in advance: the same level as making one, because
  // that is what it becomes. Re-issuing is its own event — it reopens a door that was closing.
  // Revoking one is `info`: it takes access away, and nothing that never existed can be misused.
  'invitation.created': 'WARNING',
  'invitation.resent': 'WARNING',
  'invitation.revoked': 'INFO',
  // The moment the advance assignment takes effect and a new account appears: the same level as
  // making the invitation, because this is what it was for.
  'invitation.accepted': 'WARNING',
  // `INFO`: editing a profile grants nothing and takes nothing away. What makes it worth recording
  // is that the fields are personal data and the edit may have been made by somebody else.
  'employee.updated': 'INFO',
  /**
   * `CRITICAL`, alongside `rls.bypassed`: after this entry a different person can do everything,
   * including granting themselves whatever the trail would otherwise record. An installation that
   * alerts on one event should alert on this one.
   */
  // Beside an ownership transfer, and for a comparable reason: this row decides who is locked out
  // of the organization tomorrow. Widening it lets somebody drop the requirement from their own
  // role without touching a single account, which no other entry would record.
  'organization.security_policy_updated': 'CRITICAL',
  'organization.ownership_transferred': 'CRITICAL',
  /**
   * `WARNING`, not `INFO`: deactivation ends somebody's access to everything at once, and it is the
   * entry an incident review looks for first — both when it was expected and when it was not. The
   * level belongs to the action, not to who took it.
   */
  'user.suspended': 'WARNING',
  /**
   * Also `WARNING`, and for the sharper reason: an account coming back is the step an intruder needs
   * after an offboarding, and it restores no memberships — so a reviewer seeing it must ask what was
   * granted afterwards.
   */
  'user.reactivated': 'WARNING',
  /**
   * `INFO`: a team is an org-structure container and grants nothing by itself. Since 2026-09-06 a
   * team can be the subject of a `ResourceAcl` grant (STORY-011-06), but the grant is its own
   * action (`acl.granted`, `WARNING` below); creating or renaming a team still moves no rights —
   * filing it at `WARNING` beside `role.created` would put an event that changes nobody's access
   * into the list an escalation review reads first.
   */
  'team.created': 'INFO',
  'team.updated': 'INFO',
  /**
   * `WARNING`, unlike the two above: this is the one team action that is irreversible. Every
   * membership is deleted with the team and `team_members` has no `deleted_at`, so nothing but this
   * entry — carrying the full roster and each person's role in `before` — records that the team had
   * members at all.
   */
  'team.deleted': 'WARNING',
  /**
   * `WARNING` since 2026-09-26 — the trigger STORY-012-07 recorded («когда команда станет субъектом
   * ACL») came with `POST /acl`, which accepts a `TEAM`. A membership now moves access: whoever
   * joins gets, and whoever leaves loses, every grant the team holds, and the reader matches `TEAM`
   * entries through `team_members` on the next request. That is a right given or taken away, the
   * rows an escalation review reads beside `acl.granted`; filed at `INFO` it would also degrade — a
   * failed row would let the change commit with no trace (`isDegradableAuditAction`). The entry
   * carries the caller's address for the same reason (`audit-privileged-ip-address.test.ts`).
   */
  'team.member_added': 'WARNING',
  'team.member_removed': 'WARNING',
  // Same level, same reason: the role inside a team is a membership row too, and the one entry that
  // records a person's standing on a team that may hold grants.
  'team.member_role_changed': 'WARNING',
  // An exception on one person: the layer that can take a right away, and the one whose rows an
  // escalation review reads first.
  'permission.override.created': 'WARNING',
  'permission.override.updated': 'WARNING',
  'permission.override.deleted': 'WARNING',
  // The same level as an override, and the story asks for it by name (STORY-011-06, acceptance 1):
  // a grant on an object is a right given to somebody, and the revocation is the row a reviewer
  // reads to learn when it stopped.
  'acl.granted': 'WARNING',
  'acl.revoked': 'WARNING',
  // Row-level security deliberately bypassed. Nothing in normal operation raises it, and an
  // untraced bypass is indistinguishable from an intrusion.
  'rls.bypassed': 'CRITICAL',
  // `INFO`, deliberately not `WARNING`: the read grants and takes away nothing, so it does not
  // belong beside the entries an escalation review reads first. It exists so the review can be run
  // at all — a trail, not an alarm.
  'permission.inspected': 'INFO',
  /**
   * `WARNING`, and uniformly so — the level belongs to the action, and the selection in front of
   * this action is what makes one level right for all of it. The routine refusal, the one a
   * mistimed button produces on a `GET`, never becomes an entry at all: it is a counter. What
   * reaches this action is a refusal on a key the catalogue calls dangerous or a refusal of a
   * request that would have changed something — neither is noise, and both are where an escalation
   * review starts when it asks «what were they reaching for before they got it».
   *
   * Not `CRITICAL`: nothing was granted and nothing was taken away. The entries at that level are
   * the ones where something irreversible already happened.
   */
  'access.denied': 'WARNING',
  // The same level as the entries it stands for — a summary must not read quieter than the thing
  // summarised, or an installation filtering at `WARNING` would see the first ten refusals of a run
  // and lose the evidence that it kept going.
  'access.denial_burst': 'WARNING',
  /**
   * `INFO`, like `team.created`: a project is born with nobody on it but its creator and its lead,
   * and those two seats are the caller's own and the person the caller chose — the same shape as an
   * invitation naming its roles. The rights it moves are recorded on the memberships below the day
   * anybody else is added.
   */
  'project.created': 'INFO',
  // A rename, a date, a colour, a description: nothing about access. A change of lead is the one
  // field that does move rights, and it is filed *additionally* as a membership entry at `WARNING`.
  'project.updated': 'INFO',
  /**
   * `WARNING`, and the story asks for «повышенная severity» by name (STORY-014-01, acceptance 7):
   * `PUBLIC_ORG → PRIVATE` takes the project away from everybody in the organization who is not on
   * it, in one statement, without a membership row changing. The reverse direction is filed at the
   * same level — the level belongs to the action, not to the direction.
   */
  'project.visibility_changed': 'WARNING',
  // Reversible and grants nothing: archiving hides a project from the working lists and leaves it
  // readable. The way back is STORY-014-07.
  'project.archived': 'INFO',
  /**
   * `WARNING`, like `team.deleted` and for the stronger reason: this is the one project action
   * behind a `dangerous` key that removes something, and after it the project is 404 to everybody —
   * this entry is where a reviewer learns it existed.
   */
  'project.deleted': 'WARNING',
  /**
   * `WARNING` for all three, as their team counterparts since 2026-09-26 — though for a more direct
   * reason. A team membership moves access only where the team holds a grant; a project membership
   * **is** the implicit access level of `permission-model.md` §5, so putting somebody on a project,
   * taking them off or moving them between `LEAD` and `OBSERVER` is a change of rights, and §10
   * files every change of rights at this level beside `role.assigned` and `acl.granted`.
   */
  'project.member_added': 'WARNING',
  'project.member_removed': 'WARNING',
  'project.member_role_changed': 'WARNING',
};

/** The severity of an action, for a caller that has a validated action and nothing else. */
export const severityOf = (action: AuditAction): AuditSeverity => AUDIT_ACTION_SEVERITY[action];

/** Every action carries a level — the assertion the type already makes, for a runtime reader. */
export const AUDIT_ACTIONS_WITH_SEVERITY: readonly (readonly [AuditAction, AuditSeverity])[] =
  AUDIT_ACTIONS.map((action) => [action, AUDIT_ACTION_SEVERITY[action]] as const);
