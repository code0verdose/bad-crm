import { type SharedPermissions } from '@bad-crm/shared';

import { authorizeCapability } from '@/domain/access/authorize.util.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type Decision } from '@/domain/access/decision.types.js';

/**
 * May this caller read another person's rights, permission by permission, with the origin of each?
 *
 * **`permission:override_read`, not `permission:read`.** The two keys look adjacent in the catalogue
 * and answer different questions. `permission:read` is the catalogue itself — which permissions the
 * product has — and it is the same list in every installation, secret from nobody; `manager` holds
 * it so that the roles matrix renders. What this screen answers is «what may Ivan do, and who
 * arranged it»: his personal exceptions, the sentences an administrator wrote next to them, and,
 * read across a few colleagues, the shape of how the organization is administered. That is a
 * statement about people, and `owner` and `admin` are the roles that hold it (§4.2).
 *
 * Nor `permission:explain`, which is the third question in the family — «why does Ivan reach *this
 * object*» — and needs the resource layer that does not exist yet (STORY-011-06, blocked on
 * EPIC-014). Using it here would spend the key on an answer that contains no object, and leave the
 * screen that does need it unable to ask for anything narrower.
 *
 * **No self-service branch, deliberately**, and this is where it differs from `canReadProfile` next
 * door. A person reads their own rights through `GET /me/permissions`, which answers what they may
 * do and stops there. This operation additionally carries the `reason` of every exception — a note
 * one administrator wrote for the others about a colleague — and «you may read notes about yourself»
 * is a decision for a product, not a default a policy should quietly grant.
 *
 * The subject is not an argument, exactly as in `canReadTeams` next door: today the answer does not
 * turn on who is being read, and a parameter the function ignores invites a call site to believe it
 * was checked. The day it does turn on the subject — self-reading, or a manager restricted to their
 * own reports — the signature grows and every caller is a compile error, which is the loud version.
 *
 * Pure: whether the subject exists at all is a question for the reader, and answering it here would
 * make the refusal depend on I/O. `resource_not_found` is decided by the use-case, *after* this — so
 * that a caller without the capability is refused 403 whether or not the id they guessed exists, and
 * the endpoint never becomes an oracle for who works here.
 *
 * The key is exported beside the decision so that the use-case can derive the error resource from
 * it through `refusalResourceOf`, exactly as the route guard does. Naming the resource by hand in
 * either place is how one refusal acquires two codes: the guard runs first on this route, so a
 * mismatch would be invisible until somebody called the query from anywhere else.
 */
export const INSPECT_PERMISSIONS_KEY =
  'permission:override_read' as const satisfies SharedPermissions.PermissionKey;

export const canInspectPermissions = (actor: Actor | null): Decision =>
  authorizeCapability(actor, INSPECT_PERMISSIONS_KEY);
