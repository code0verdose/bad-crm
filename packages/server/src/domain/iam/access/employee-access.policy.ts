import { authorizeCapability } from '@/domain/access/authorize.util.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, deny } from '@/domain/access/decision.util.js';

/**
 * The fields anybody may change **about themselves**, and the whole of that list.
 *
 * The line is not «what is harmless» but «what is a statement about the person rather than about
 * their employment». A name, a timezone and a list of skills are the first: nobody else is a better
 * authority on them, and a form that made an administrator retype somebody's surname is a form that
 * keeps the wrong surname for a year.
 *
 * The language is deliberately not on the list, and not because it is sensitive: it lives on the
 * **account** (`users.locale`), which this operation does not write. Listing it here would promise
 * something the endpoint cannot do.
 *
 * `jobTitle`, `department`, `managerId`, `weeklyCapacityHours`, `employmentType`, `hiredAt` and
 * `terminatedAt` are the second, and they are not self-service for a reason that is not about trust:
 * they are what planning, cost and the org chart are computed from. A person who can set their own
 * capacity to eighty hours changes what the dashboards say about the team, and a person who can
 * choose their own manager changes who approves their timesheet.
 */
export const SELF_SERVICE_FIELDS = [
  'firstName',
  'lastName',
  'timezone',
  'skills',
  'emergencyContact',
] as const;

export type SelfServiceField = (typeof SELF_SERVICE_FIELDS)[number];

const SELF_SERVICE = new Set<string>(SELF_SERVICE_FIELDS);

/** Which fields an edit is trying to change — the keys the request actually carried. */
export type ChangedFields = readonly string[];

/**
 * May this actor make **this** edit to **this** person's profile?
 *
 * Two questions, in this order, and the order is what makes the answers useful:
 *
 * 1. **Whose record is it.** Somebody else's needs `employee:update`, always — even for a field
 *    anybody may change about themselves. «Anybody may fix their own surname» does not mean «anybody
 *    may fix a colleague's surname», and the second is how a directory gets quietly rewritten.
 * 2. **Which fields.** On one's own record, only the self-service list above. An HR field in the
 *    body of a self-edit is `permission_not_granted` rather than a silently ignored key: dropping it
 *    would let a form claim it saved something it did not.
 *
 * The owner is exempt from the capability half, like everywhere else — ownership short-circuits the
 * capability layers, so their permission set is empty rather than complete.
 */
export const canEditProfile = (
  actor: Actor,
  subjectUserId: string,
  changed: ChangedFields,
): Decision => {
  const isSelf = actor.userId === subjectUserId;

  if (!isSelf) return authorizeCapability(actor, 'employee:update');
  if (actor.isOwner) return allow();

  const hrFields = changed.filter((field) => !SELF_SERVICE.has(field));

  if (hrFields.length === 0) return allow();

  // Editing one's own employment record is still editing an employment record.
  return authorizeCapability(actor, 'employee:update');
};

/**
 * What of a profile this actor may **see** — two independent audiences beside the public half.
 *
 * **Flags, not a ladder, and the difference is a privilege escalation.** This was written as three
 * widening levels — `public` → `personal` → `cost` — and every consumer then asked «is it not
 * public?», so `employee:view_cost_rate` silently carried the whole employment half with it,
 * decrypted emergency contact included. The built-in `manager` role holds exactly that capability
 * and **not** `employee:view_personal_data` (`permission-model.md` §7), so the widest audience in
 * the product was reachable by a role the matrix says must not have it.
 *
 * The two are separate because they answer different questions (`permission-model.md` §4.1):
 * knowing when somebody was hired is not knowing what they are paid, and an administrator holds the
 * first without the second while a manager holds the second without the first. Neither implies the
 * other in either direction, which a ladder cannot express and a pair of booleans cannot get wrong.
 *
 * Returning the decision rather than a serialised profile keeps the judgement in `domain` and the
 * shaping in `presentation`, which is the split invariant 2 asks for.
 */
export interface ProfileAudience {
  /**
   * The employment half: contract type, hiring and termination dates, weekly capacity, emergency
   * contact. Your own is always yours to read — the dates are on your own contract, and hiding them
   * from you would be theatre.
   */
  readonly personal: boolean;
  /** Rates, which arrive with their own table in M6. Never implied by `personal`. */
  readonly cost: boolean;
}

export const profileAudience = (actor: Actor, subjectUserId: string): ProfileAudience => ({
  personal:
    actor.userId === subjectUserId ||
    authorizeCapability(actor, 'employee:view_personal_data').allowed,
  cost: authorizeCapability(actor, 'employee:view_cost_rate').allowed,
});

/**
 * A subject id no actor can hold, so that «anybody but me» can be asked without naming a person.
 * Account ids are UUIDs; the empty string is not one.
 */
const SOMEBODY_ELSE = '';

/**
 * May this actor see the employment half of **somebody else's** record?
 *
 * Asked by the directory about the request rather than about a row: what a page may be **ordered
 * by** is one decision for the whole page, and ordering by a column the caller cannot read is a side
 * channel — page through a list sorted by hiring date and you have learnt everybody's, one
 * comparison at a time.
 *
 * Derived from `profileAudience` rather than repeating the capability name, so that a change to what
 * makes a record personal cannot be applied there and forgotten here. It reads `.personal` and not
 * «any audience at all»: the cost audience answers a different question and must not buy an order
 * by hiring date either.
 */
export const seesEmploymentOfOthers = (actor: Actor): boolean =>
  profileAudience(actor, SOMEBODY_ELSE).personal;

/** Reading somebody's profile at all. A person may always read their own. */
export const canReadProfile = (actor: Actor, subjectUserId: string): Decision =>
  actor.userId === subjectUserId ? allow() : authorizeCapability(actor, 'employee:read');

/** The refusal a cycle produces, kept here so the use-case names a decision rather than a string. */
export const managerCycleRefused = (): Decision => deny('manager_cycle_detected');

/**
 * An employment that would end before it began.
 *
 * Decided on the **merged** pair — what the record will hold after the patch — rather than on the
 * body, because a PATCH may carry only the termination date and still invert it against a hiring
 * date stored months ago. `null` on either side is not a violation: an employment with no end is the
 * ordinary case, and one with no start is a record nobody has filled in yet.
 *
 * The database says the same thing (`ck_employee_profiles_employment_period`). This exists so the
 * answer is a named 422 rather than `23514` arriving at the error handler as an unrecognised failure
 * and leaving as a 500 — the same reason `closesManagerCycle` exists next door.
 */
export const employmentPeriodInverted = (period: {
  readonly hiredAt: Date | null;
  readonly terminatedAt: Date | null;
}): boolean =>
  period.hiredAt !== null &&
  period.terminatedAt !== null &&
  period.terminatedAt.getTime() < period.hiredAt.getTime();

export const employmentPeriodRefused = (): Decision => deny('employment_period_inverted');
