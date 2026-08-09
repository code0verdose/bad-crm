/**
 * What a privileged action is called in the audit trail.
 *
 * A closed list rather than free-form strings, for the same reason the permission catalogue is one:
 * an action named at a call site is an action nobody reviewed, and a typo opens a second name for
 * the same event — which a filter over the trail then silently misses. A new kind of privileged
 * action is added here deliberately, in the pull request that introduces it.
 *
 * The names are `<subject>.<verb>` in the past tense: the trail records what **happened**, not what
 * was attempted. An attempt that failed is a different record, and today it is not one this list
 * carries.
 */
export const AUDIT_ACTIONS = [
  /** An organization and its first owner were created (STORY-006-01). */
  'organization.registered',
  /** A credential was accepted and a session issued. */
  'session.signed_in',
  /** A session was ended by its owner, or revoked from the session list. */
  'session.revoked',
  /** A password was changed by the person who knew the old one. */
  'password.changed',
  /** A password was set through a recovery link. */
  'password.reset',
  /** A custom role was composed, recomposed or removed (STORY-011-03). */
  'role.created',
  'role.updated',
  'role.deleted',
  /**
   * A role was stored containing a key the catalogue marks dangerous.
   *
   * A second entry beside `role.created`/`role.updated` rather than the same one filed louder:
   * severity comes from the action and never from the call site, and «show me every time somebody
   * put `user:impersonate` into a role» is the question an escalation review actually asks — a
   * filter answers it, re-reading every composition does not.
   */
  'role.dangerous_granted',
  /** A role was given to somebody (STORY-011-04). */
  'role.assigned',
  /** A role was taken away, by an administrator or by the expiry of a temporary grant. */
  'role.revoked',
  /**
   * An invitation was created, re-issued with a fresh token, or closed early (STORY-012-01).
   *
   * Filed beside the role events rather than with the account ones: an invitation **is** a role
   * assignment written in advance, and the review that asks «who was given what» has to see both.
   */
  'invitation.created',
  'invitation.resent',
  'invitation.revoked',
  /**
   * An invitation was taken up: an account exists that did not exist before, holding the role and
   * the teams the invitation drafted (STORY-012-02).
   *
   * Beside the three above rather than with the session events, because this is the moment the
   * assignment written in advance takes effect — «who was given what» has to see it in one place.
   */
  'invitation.accepted',
  /**
   * A personnel record was edited — by an administrator, or by the person themselves within the
   * self-service list (STORY-012-03).
   *
   * The entry names the **fields** that changed and never their values: an emergency contact in the
   * trail would undo the column being ciphertext, and the reviewer needs «HR data was edited, by
   * whom, about whom», not the data itself.
   */
  'employee.updated',
  /**
   * The organization changed hands (STORY-012-06).
   *
   * The one entry in this catalogue that records a change to who can do **everything**: the owner
   * short-circuits every capability layer, so this event is the boundary between two people's
   * authority over an installation. `before`/`after` carry both ids, and nothing else needs to.
   */
  'organization.ownership_transferred',
  /**
   * An account was deactivated or brought back (STORY-012-05).
   *
   * `user.suspended` is the offboarding entry, and it is deliberately one action rather than a
   * family of them: deactivation is a **single** operation that revokes sessions, leaves teams and
   * stops the account, and a trail that recorded those separately would let a reviewer see three
   * quarters of an offboarding and believe it complete. What was actually revoked travels in
   * `after`, as counters.
   *
   * `user.reactivated` is not its mirror image, and the entry says so: memberships are **not**
   * restored, so the two events do not cancel out and the trail must not read as if they did.
   */
  'user.suspended',
  'user.reactivated',
  /**
   * A team was created, renamed or removed (STORY-012-07).
   *
   * A `Team` is an org-structure container and **not** a group of access: no permission is derived
   * from membership today, and the resource ACL that would make one the subject of a grant does not
   * exist yet (STORY-011-06, blocked). The entries are therefore about the shape of the
   * organization, which is why two of them read at `INFO` and only the deletion does not.
   */
  'team.created',
  'team.updated',
  /**
   * A team was removed and every membership it held went with it.
   *
   * `team_members` has no `deleted_at`: the rows are deleted outright, so this entry is the only
   * record that the memberships existed at all. `before` therefore carries the full roster, each
   * person with the role they held — the same choice `user.suspended` makes for the teams an
   * offboarded person leaves, and for the identical reason: a reviewer asking «who was on that team»
   * has nothing else to read, and whoever re-grants access later needs to know *what* to grant, not
   * only how many people needed it.
   */
  'team.deleted',
  /**
   * Somebody joined or left a team (STORY-012-07).
   *
   * Separate actions rather than one `team.members_changed`, because they are separate questions:
   * «when did this person join» and «when were they taken off» are asked at different times by
   * different people, and one action carrying a direction in its payload answers neither with a
   * filter.
   */
  'team.member_added',
  'team.member_removed',
  /**
   * An existing member's role changed — `MEMBER` to `LEAD` or back — through the same
   * `POST /teams/{teamId}/members` a first join uses (the gate's L-3 fix: there is no separate
   * endpoint, because the lead is `team_members.team_role` and not a column of its own).
   *
   * A third action beside the two above rather than a direction folded into `team.member_added`, for
   * the identical reason those two are already separate: «when did this person become lead» is a
   * question asked on its own, and a filter over `team.member_added` would have to also inspect
   * `before`/`after` to answer it.
   */
  'team.member_role_changed',
  /** A per-user exception was written, replaced or removed (STORY-011-05). */
  'permission.override.created',
  'permission.override.updated',
  'permission.override.deleted',
  /**
   * Row level security was bypassed on purpose — a migration path, a support action, a background
   * job that must see every tenant.
   *
   * The one entry here that records a *capability* rather than a change to data, and the reason the
   * trail exists at all for an installation whose operator can reach the database: an untraced
   * bypass is indistinguishable from an intrusion.
   */
  'rls.bypassed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const AUDIT_ACTION_SET: ReadonlySet<string> = new Set<string>(AUDIT_ACTIONS);

export const isAuditAction = (value: string): value is AuditAction => AUDIT_ACTION_SET.has(value);
