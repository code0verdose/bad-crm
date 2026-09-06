import { SharedPermissions } from '@bad-crm/shared';

/**
 * Which refusals are written down, and under what name — §10 of the permission model as a table.
 *
 * ## Why this is not «record every refusal»
 *
 * A refusal is the one outcome an attacker chooses. Writing a row for each one would mean the
 * cheapest request somebody can send is the most expensive one this installation answers: an
 * unauthenticated flood, or an authenticated account walking identifiers, would fill a partitioned,
 * append-only table that nothing may delete from — faster than anybody reads it, and while the trail
 * still has to hold the entries an incident review actually needs. This is the same class of problem
 * the argon2 ceiling answers (`docs/security/threat-model.md`, RR-10) and the same shape of answer
 * `user.mfa_recovery_locked_out` gives: record the thing that is evidence, count the rest, and cap
 * what one subject can make the system write.
 *
 * So there are three filters, and each takes away a different flood:
 *
 * 1. **the reason** — this table. Only a refusal *of access* is an entry; a state conflict is not,
 *    and neither is a failure of ours;
 * 2. **the class of request** — `recordableDenial` below: a dangerous key always, a mutation always,
 *    an ordinary read never. The refused `GET` is the cheap, repeatable one, and it keeps
 *    `permission_denied_total{reason}` and nothing else;
 * 3. **the budget per actor per minute** — not here, because it needs a store: see
 *    `application/access/use-cases/record-denied-access.use-case.ts`.
 *
 * ## Why the recorded reason is not always the `DenyReason`
 *
 * `resource_not_found` and `tenant_mismatch` answer the same 404 on purpose: from outside, «not
 * yours» and «not there» must be one answer, or the API is an oracle for the existence of other
 * organizations' rows (invariant 2 of `CLAUDE.md`). The trail is read by everybody in the
 * organization who holds `audit:read`, so spelling the two differently *there* would rebuild the
 * oracle one layer in — a caller probes an id, then reads their own journal to see which of the two
 * words came back. They are therefore one word here, and the `DenyReason` that produced it does not
 * survive into the row.
 *
 * `null` means «not an entry». It is a total `Record`, so a reason added to the catalogue does not
 * compile until somebody decides which of the two it is — the default branch that would otherwise
 * quietly answer for it is exactly how a new refusal ends up recorded, or not, by accident.
 */
export const AUDITED_DENIAL_REASON: Readonly<Record<SharedPermissions.DenyReason, string | null>> =
  {
    /**
     * No entry, and this is the load-bearing one.
     *
     * There is no subject to name — no user, and therefore no organization, while `audit_logs` is a
     * tenant table with `organization_id NOT NULL`. Extending `AUDIT_ACTIONS_WITHOUT_ORGANIZATION` to
     * send these to the log sink instead was considered and refused: it would route the one stream
     * this system cannot bound — unauthenticated, unattributable, produced by anybody who can reach
     * the port — into the trail's own channel, to say «somebody, somewhere, was not signed in». The
     * counter says that already, and the HTTP completion line carries the rest.
     */
    not_authenticated: null,
    /** A key outside the catalogue: a typo, or a permission a release removed. Worth knowing. */
    unknown_permission: 'unknown_permission',
    permission_not_granted: 'permission_not_granted',
    /** The layer that takes a right away from one person — the rows an escalation review reads. */
    denied_by_override: 'denied_by_override',
    resource_required: 'resource_required',
    // Collapsed with `tenant_mismatch`, see the note above. Both are `not_found` and nothing else.
    resource_not_found: 'not_found',
    acl_explicit_none: 'acl_explicit_none',
    insufficient_acl_level: 'insufficient_acl_level',
    tenant_mismatch: 'not_found',
    /**
     * No entry: the ACL could not be read, which is this installation failing rather than a caller
     * being refused. It answers 503, it is somebody's outage, and filing it beside real refusals would
     * put our own broken database into the list an escalation review reads first.
     */
    acl_resolution_failed: null,
    /** No entry: the session is fine and the caller may act — the vault is simply locked in it. */
    vault_locked: null,
    /**
     * No entry for any of the refusals below. They are conflicts and unfixable-shape errors — 409
     * for the last owner, a closed period, a system role, an invitation already spent; 422 for a
     * cycle of managers, an inverted employment period, an impossible recipient (which is which is
     * decided by `packages/shared/src/errors/error-code.enums.ts`, not here). What they have in
     * common is the part that matters: the caller holds the right and the object exists, so none of
     * them is a refusal of *access*. Recording them as one would drown the entries that are in the
     * ordinary friction of using the product.
     */
    period_locked: null,
    last_owner_required: null,
    self_lockout: null,
    system_role_immutable: null,
    owner_immutable: null,
    invitation_already_accepted: null,
    manager_cycle_detected: null,
    employment_period_inverted: null,
    invalid_recipient: null,
    /** These two are refusals of access, not conflicts: the caller may act, but not on this side. */
    self_assignment_forbidden: 'self_assignment_forbidden',
    not_the_owner: 'not_the_owner',
  };

/**
 * The methods after which something is different — matched case-insensitively, because a method is
 * an opaque token to Express and «post» reaches a handler unchanged.
 */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface DeniedAccessFacts {
  readonly reason: SharedPermissions.DenyReason;
  /** Absent when the refusal was not about a key — a policy on a state, an ownership check. */
  readonly permissionKey: SharedPermissions.PermissionKey | undefined;
  readonly method: string;
}

export interface RecordableDenial {
  /** As it goes into the row: collapsed where two reasons must read alike. */
  readonly reason: string;
  /** Which of the two rules put it in the trail — the answer to «why is this row here». */
  readonly because: 'dangerous_permission' | 'mutating_request';
}

/**
 * Whether this refusal becomes a row, and what it says if it does.
 *
 * `null` is «a counter and nothing else», which is the answer for most refusals and deliberately so.
 * Pure: no clock, no store, no I/O — the budget that bounds a run needs all three and lives one
 * layer out.
 */
export const recordableDenial = (facts: DeniedAccessFacts): RecordableDenial | null => {
  const reason = AUDITED_DENIAL_REASON[facts.reason];

  if (reason === null) return null;

  // A dangerous key first, and independent of the method: §10 files a refusal on one whatever the
  // request was, because reading the roster of who may impersonate whom is itself the reconnaissance
  // step. `PERMISSION_META` is the catalogue's own flag, so nothing here maintains a second list.
  if (facts.permissionKey !== undefined) {
    if (SharedPermissions.PERMISSION_META[facts.permissionKey].dangerous) {
      return { reason, because: 'dangerous_permission' };
    }
  }

  return MUTATING_METHODS.has(facts.method.toUpperCase())
    ? { reason, because: 'mutating_request' }
    : null;
};
