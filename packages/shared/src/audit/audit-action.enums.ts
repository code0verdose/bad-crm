/**
 * What a privileged action is called in the audit trail.
 *
 * A closed list rather than free-form strings, for the same reason the permission catalogue is one:
 * an action named at a call site is an action nobody reviewed, and a typo opens a second name for
 * the same event — which a filter over the trail then silently misses. A new kind of privileged
 * action is added here deliberately, in the pull request that introduces it.
 *
 * The names are `<subject>.<verb>` in the past tense: the trail records what **happened**, not what
 * was attempted.
 *
 * **That was once a rule and is now a tendency** (corrected 2026-09-06). This list carries four
 * entries about something that did not succeed — `user.mfa_setup_failed`,
 * `user.mfa_recovery_locked_out`, `access.denied` and `access.denial_burst` — and each states why it
 * earns the exception in its own entry below. What they have in common is that the *attempt* is the
 * evidence: a run of wrong recovery codes, or a refusal on a key somebody should not have been
 * reaching for, is what an incident review starts from. A single ordinary miss is still not a
 * record — it is a counter and a log line. Anything quoting the older, absolute form of this
 * sentence as the reason not to file some attempt (`docs/security/threat-model.md` RR-09 did) is
 * quoting a premise that no longer holds; the conclusion may still, on its own merits.
 */
export const AUDIT_ACTIONS = [
  /** An organization and its first owner were created (STORY-006-01). */
  'organization.registered',
  /** A credential was accepted and a session issued. */
  'session.signed_in',
  /** A session was ended by its owner, or revoked from the session list. */
  'session.revoked',
  /**
   * A refresh token was presented after it had already been spent, outside the rotation race
   * window — the whole family was revoked because of it (STORY-006-03).
   *
   * A distinct entry from `session.revoked` rather than the same action with a different reason:
   * the two answer different questions an incident review asks — "somebody closed a device" versus
   * "a token this server issued was replayed by whoever is not supposed to hold it" — and folding
   * them would make the second question, the one worth an alert, unanswerable by a filter over the
   * trail. `after` carries the family, the count of sessions the revocation actually closed, and
   * the address the token came back from; never the token or its digest, on the identical reasoning
   * `session.signed_in`'s own call site keeps them out of the log line this entry sits beside
   * (`refresh-session.use-case.ts`, `SECURITY_EVENTS.refreshReuseDetected`).
   */
  'session.refresh_reuse_detected',
  /** A password was changed by the person who knew the old one. */
  'password.changed',
  /** A password was set through a recovery link. */
  'password.reset',
  /**
   * TOTP was confirmed and switched on for the account (STORY-013-01).
   *
   * Filed the moment `totpEnabledAt` is set — not at `setup`, which only drafts a secret nobody has
   * proven possession of yet. Everything about *what* the secret is stays out of the entry: `before`
   * and `after` never carry a key or a code, only the fact that the account gained a second factor.
   */
  'user.mfa_enabled',
  /**
   * Five TOTP codes in a row were refused during enrolment and the draft secret was invalidated
   * (STORY-013-01, acceptance 4).
   *
   * A distinct entry from an ordinary `auth_attempt` refusal — those are logged, not audited — because
   * this one ends in a state change: the draft is gone, and whoever set it up has to scan a new QR
   * code. A reviewer asking "why did this person's enrolment reset itself" needs this in the trail,
   * not only in a rate-limiter counter that expires.
   */
  'user.mfa_setup_failed',
  /**
   * A recovery code was spent to open a session in place of a TOTP code (STORY-013-02, acceptance 4).
   *
   * Its own entry rather than folded into `session.signed_in`: a sign-in that consumed a recovery code
   * is the one an incident review reaches for first when an authenticator was reported lost — the
   * codes are what stood between the account and administrator reset, and using one is worth knowing
   * about on its own even when the outcome is an ordinary, successful sign-in.
   */
  'user.mfa_recovery_code_used',
  /**
   * A run of refused recovery codes exhausted the `mfa_recovery_consume_attempt` budget
   * (STORY-013-02, acceptance 10).
   *
   * The one entry in this catalogue that records something that **did not** succeed, and the
   * exception is deliberate rather than an oversight of the rule stated at the top of this file: a
   * single wrong code is a typo and belongs in the log, while a run of them against the credential
   * that exists specifically for "I lost my authenticator" is somebody working through a printed
   * sheet they should not have. `user.mfa_setup_failed` is the same shape for enrolment.
   *
   * **One entry per run, not one per attempt.** It is filed by the refusal that spends the last of
   * the budget; every attempt after it is turned away by the limiter before a code is compared, so
   * the next entry costs the caller a whole new budget. A record per attempt would be the rate-limiter
   * counter written twice, and would bury the runs it exists to surface.
   *
   * `after` names which budget was burnt and nothing else — no code, no digest, not how many unused
   * codes the account still holds, which is precisely the number the fixed-cost match in
   * `ConsumeRecoveryCodeUseCase` refuses to leak through elapsed time.
   */
  'user.mfa_recovery_locked_out',
  /**
   * The recovery code set was replaced: every unused code was invalidated and a fresh set of ten
   * was issued (STORY-013-02, acceptance 7).
   *
   * Reachable only after the caller reauthenticated with both the current password and a live TOTP
   * code — `reauthentication_required` refuses everything short of that — so the entry doubles as the
   * record that the stronger check was actually exercised, not only configured.
   */
  'user.mfa_recovery_codes_regenerated',
  /**
   * The account owner turned their own 2FA off: `POST /auth/2fa/disable` (STORY-013-04, acceptance
   * 1). Reachable only after both the current password and a live proof of the second factor — a
   * TOTP code or a recovery code — were checked. `after.secondFactorKind` names which of the two it
   * was (`'totp' | 'recovery_code'`) — a fact, not a secret: it carries no code and no hash, and it is
   * exactly what an incident review needs to tell "the printed sheet was used" from "the authenticator
   * app was". `before`/`after` never carry the code or hash themselves, only this fact and the count
   * of recovery codes the disable deleted with it.
   */
  'user.mfa_disabled',
  /**
   * An administrator switched a colleague's 2FA off through `user:reset_mfa` (STORY-013-04,
   * acceptance 5).
   *
   * A distinct entry from `user.mfa_disabled` rather than the same action with a different actor:
   * the two answer different questions an incident review asks — "did the owner choose this" versus
   * "did somebody else choose it for them" — and folding them would make the second question
   * unanswerable by a filter. `after` carries the counts the operation actually produced (sessions
   * revoked, recovery codes deleted), the same reasoning `user.suspended` gives for recording
   * offboarding as counters rather than as reassurance.
   */
  'user.mfa_reset_by_admin',
  /**
   * A role was composed, recomposed or removed.
   *
   * Two callers, and the second is why the entry names no person by construction: an administrator
   * editing a custom role (STORY-011-03), and the upgrade path re-applying the system matrix to
   * every organization of an installation (STORY-011-02, acceptance 7), which files these as
   * `actorType = SYSTEM`. The second is deliberately not an action of its own — a reader asking
   * «what happened to this role» must not have to know which of the two moved it — and it is filed
   * only when the composition actually moved, so an idempotent re-run leaves the trail alone.
   */
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
   * authority over an installation. `before` and `after` name the column that *is* the authority —
   * `{ ownerId }` on each side — plus `previousOwnerRoleKey`, the one fact of the handover that is
   * written nowhere else: which role the outgoing owner was left holding.
   */
  /**
   * The organization's security policy changed — today, which roles must carry a second factor and
   * how long they have to arrange it (STORY-013-05, acceptance 1).
   *
   * `before` and `after` carry the policy itself: role references and a number of days, no secrets
   * and nothing about any individual. A change here decides whether an account can sign in at all
   * once its grace period runs out, which is why it is filed `CRITICAL` beside an ownership
   * transfer rather than beside a rename.
   */
  'organization.security_policy_updated',
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
   * from membership as such. Since 2026-09-06 a team can be the subject of a `ResourceAcl` grant
   * (STORY-011-06, `acl.granted` below), and then membership carries that grant — the grant is the
   * privileged action and is filed at `WARNING`; joining a team is still the shape of the
   * organization, which is why two of these three read at `INFO` and only the deletion does not.
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
   * A grant on one object was written or replaced, or taken away (STORY-011-06).
   *
   * Beside the override events rather than beside the role ones, because that is what it is: layer 4
   * of the model is the other place a right is given to one subject about one thing, and the
   * escalation review that reads `permission.override.*` has to see both. `after` names the object
   * as a (type, id) pair, the subject the same way, the level and the expiry — never a row of the
   * object itself, which the trail has no business copying.
   */
  'acl.granted',
  'acl.revoked',
  /**
   * Row level security was bypassed on purpose — a migration path, a support action, a background
   * job that must see every tenant.
   *
   * The one entry here that records a *capability* rather than a change to data, and the reason the
   * trail exists at all for an installation whose operator can reach the database: an untraced
   * bypass is indistinguishable from an intrusion.
   */
  'rls.bypassed',
  /**
   * An administrator read another person's effective permissions —
   * `GET /users/{userId}/permissions` (STORY-011-11).
   *
   * The one **read** this catalogue records, and — as of 2026-08-12 — the only entry that concerns
   * `GET /users/{userId}/permissions` at all. Two properties of the *answer* are why it earns the
   * exception where an ordinary `GET` does not: it hands back the sentences one administrator wrote
   * about a colleague under a `reason`, and reading it about everyone in turn draws the map of how
   * the organization is actually administered — the same reasoning that makes `audit.exported`,
   * `vault.escrow_used` and `VaultAccessLog`'s own `VIEW` entry logged reads instead of silent ones.
   *
   * **It covers the successful branch; the refusal is `access.denied` below** (closed 2026-09-06).
   * Until then this entry said the refused branch was recorded nowhere, and that was true: §10's
   * rule «a denial on a dangerous key is always filed» had no implementation. It does now — a caller
   * enumerating the roster without `permission:override_read` is refused on a key the catalogue
   * marks dangerous, which is one of the two classes `access.denied` records.
   */
  'permission.inspected',
  /**
   * Somebody was refused access, and the refusal was one worth keeping (STORY-016-02, acceptance 7;
   * the audit half of STORY-011-07, acceptance 2).
   *
   * **Not every refusal.** A row per refusal would make the cheapest request an attacker can send
   * the most expensive one this system answers, so the selection is deliberately narrow and lives in
   * one place — `domain/access/denied-access-audit.policy.ts`. Recorded are a refusal on a key the
   * catalogue marks `dangerous` and a refusal of a request that would have changed something; an
   * ordinary refused `GET` leaves `permission_denied_total{reason}` and nothing else, and an
   * unauthenticated caller leaves not even a subject to name.
   *
   * **The reason in `after` is not always the `DenyReason` the response carried.** `tenant_mismatch`
   * and `resource_not_found` are spelled identically — `not_found` — because they answer the same
   * 404 on purpose (invariant 2), and a journal that distinguished them would be the oracle the API
   * refuses to be, readable by everyone in the organization who may read the trail.
   *
   * `after` carries the reason, the permission key (or `null`), the method and which of the two
   * rules put it here. Never the URL: a path segment of this product can itself be a credential.
   */
  'access.denied',
  /**
   * A run of refusals from one actor exhausted what one actor may write to the trail in a minute —
   * one entry standing for the rest of the run (STORY-016-02, acceptance 7).
   *
   * The same shape as `user.mfa_recovery_locked_out`, and for the same reason: a record per attempt
   * is the rate-limiter's counter written twice, and it buries the runs it exists to surface. Here
   * there is a second reason the pattern is not optional — the entries are written by whoever is
   * being refused, so an unbounded writer is an amplifier pointed at the installation's own
   * database. `after` names the budget and the window, and nothing about the individual attempts:
   * how many were suppressed is not knowable without a second read, and the counter already answers
   * it.
   */
  'access.denial_burst',
  /**
   * A project was created (STORY-014-01, acceptance 1), with the creator and the lead written as
   * its first `LEAD` memberships in the same transaction.
   *
   * One entry rather than one plus a `project.member_added` per seat: the two memberships are not
   * somebody being *put on* an existing project — they are the project's initial state, and a
   * reviewer asking «who was on it from the start» reads it off `after.members` the way
   * `team.deleted` carries its roster. A membership written later is its own entry below.
   */
  'project.created',
  /**
   * The editable fields of a project were replaced — name, description, dates, colour, lead
   * (STORY-014-01, acceptance 3). `key` is never on this entry: it is part of every task number
   * and cannot change.
   *
   * A change of `leadId` is recorded here **and** as a membership entry: the column is what the
   * card shows, the `LEAD` membership is what grants `MANAGER`, and the second is the one an
   * escalation review reads. The use-case writes both in one transaction.
   */
  'project.updated',
  /**
   * `PUBLIC_ORG` ↔ `PRIVATE` (STORY-014-01, acceptance 7). Behind a `dangerous` key, because the
   * direction that matters takes access away from everybody in the organization who was not on the
   * project, and does so without a single membership row changing — the only place that loss is
   * visible is this entry.
   */
  'project.visibility_changed',
  /**
   * The project's status became `ARCHIVED` (STORY-014-01; the confirmation, the read-only rule and
   * the way back are STORY-014-07). A repeat on an archived project files nothing: the state the
   * caller asked for already held.
   */
  'project.archived',
  /**
   * The project was soft-deleted: hidden from every list and answered 404 by id, its `key` freed
   * for reuse (STORY-014-01, acceptance 11). The memberships stay as history — `project_members`
   * has `left_at` — so unlike `team.deleted` this entry does not have to carry the roster to keep
   * it from vanishing; it carries it anyway, because it is the one place the roster *at the moment
   * of deletion* is readable without a join over rows that may since have been ended.
   */
  'project.deleted',
  /**
   * Somebody was put on a project (STORY-014-02, acceptance 1). Unlike `team.member_added`, this is
   * a change of rights: `projectRole` is the source of the implicit access level (`LEAD → MANAGER`,
   * `MEMBER → EDITOR`, …), and a `PRIVATE` project exists for this person from this row on. The
   * self-join attack `T-PROJ-02` describes — «добавил себя, прочитал, удалил» — is what
   * `after.userId` beside `actor.userId` makes visible (acceptance 11, `T-PROJ-04`).
   */
  'project.member_added',
  /** A membership ended: `left_at` stamped, the row kept (STORY-014-02, acceptance 5). */
  'project.member_removed',
  /**
   * The role of a live membership changed — a promotion to `LEAD` or a demotion from it (STORY-014-02,
   * acceptance 4). Filed only when the **role** moves: a change of `allocationPct` alone grants and
   * takes nothing, and is not an entry.
   */
  'project.member_role_changed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const AUDIT_ACTION_SET: ReadonlySet<string> = new Set<string>(AUDIT_ACTIONS);

export const isAuditAction = (value: string): value is AuditAction => AUDIT_ACTION_SET.has(value);
