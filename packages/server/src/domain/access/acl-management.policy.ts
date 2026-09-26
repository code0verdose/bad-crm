import { type AclGrantDraft } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { authorize, authorizeWith, type AclScope } from '@/domain/access/authorize.util.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, deny } from '@/domain/access/decision.util.js';

/**
 * `self_lockout` when the entry reaches the actor — their own `USER` entry by id, a role or a team
 * by the membership fact, asked only here — and an allow otherwise. Both halves of case 11 end here
 * once they know the change would leave the entry below `MANAGER`.
 */
const lockoutIfReaches = async (
  actor: Actor,
  subject: AclGrantDraft['subject'],
  reachesActor: () => Promise<boolean>,
): Promise<Decision> => {
  const reaches = subject.type === 'USER' ? subject.id === actor.userId : await reachesActor();

  return reaches ? deny('self_lockout') : allow();
};

/**
 * Who may hand out a grant on an object, to whom, and how wide.
 *
 * The first question is the ordinary one and is not restated: `authorize` is the conjunction of the
 * capability (`acl:grant`) and the level held on the object (`MANAGER`, the catalogue's
 * `requiredLevel`), in the model's order — nothing about the object is consulted until the
 * capability holds, and a missing object is a 404 before it is anything else.
 *
 * **No wider than one's own level** (STORY-011-06, acceptance 11) is a rule of this decision and
 * is not a line of it: `acl:grant` carries `requiredLevel: MANAGER` in the catalogue, `MANAGER` is
 * the top of the scale, so whoever passed the conjunction already holds the widest level there is,
 * and a branch for the other case would be one nothing can reach and no test can prove. What
 * keeps the rule true is the catalogue entry, and `acl-management-policy.test.ts` pins it: the day
 * `requiredLevel` is lowered, that test fails and the comparison has to be written here — the same
 * shape as the subset rule in `permission-override.policy.ts`, which *is* reachable.
 *
 * One rule is specific to granting and sits on top — **no locking oneself out**
 * (`permission-model.md`, «Краевые случаи», 11: an operation that takes from the actor the right by
 * which rights are governed is refused as `self_lockout`). On an object that right is `MANAGER`,
 * which is what `acl:grant` and `acl:revoke` require. A grant below it that reaches the actor — their
 * own `USER` entry, a role they hold, a team they are on — becomes the closest explicit entry for
 * them on this node (resolution rule 1; an explicit entry also replaces the implicit level, so a
 * project lead granting their own team `EDITOR` is the everyday form of this), and they are left
 * with that level and no way to undo it. `NONE` is the extreme of the same case, not a separate one.
 *
 * **Fail-closed, and deliberately so.** The node's level is the maximum over everything matching the
 * actor there (rule 2), and the policy does not see the other entries: a narrowing that another
 * `MANAGER` entry on the same node would have made harmless is refused as well. The recourse is the
 * one the model gives everywhere — another manager, or the owner, makes the change.
 *
 * Whether a role or a team reaches the actor is a fact about their memberships, so it comes as a
 * thunk and is asked **only** when it decides the answer: the capability and the level hold, the
 * actor is not the owner, the level is below `MANAGER` and the subject is not a person (a person is
 * compared by id). Every other grant costs no membership read — until 2026-09-26 this file declined
 * the team case on exactly that price, and the thunk is what removes it.
 *
 * The owner passes: ownership replaces the layers rather than enumerating them, and nothing can
 * lock the owner out by construction (`authorizeResource`).
 */
export const canGrantAcl = async (
  actor: Actor,
  scope: AclScope,
  draft: AclGrantDraft,
  reachesActor: () => Promise<boolean>,
): Promise<Decision> => {
  const conjunction = authorize(actor, 'acl:grant', scope);

  if (!conjunction.allowed || actor.isOwner || draft.level === 'MANAGER') return conjunction;

  return lockoutIfReaches(actor, draft.subject, reachesActor);
};

/**
 * The same rule for taking a grant away — the revocation half of case 11. It runs after
 * `canRevokeAcl`, on the row that decision was made about.
 *
 * Removing an entry can lower the actor's level on the node only when the entry is `MANAGER`: the
 * node's level is the maximum of what matches (rule 2), so an entry below it was never what held the
 * actor there. With a `MANAGER` entry that reaches them gone, their level falls to whatever else
 * matches, to the ancestors or to the implicit level — which of these the policy cannot see, so it
 * refuses, as for a grant. The owner passes, as everywhere.
 */
export const canRevokeAclEntry = async (
  actor: Actor,
  entry: AclGrantDraft,
  reachesActor: () => Promise<boolean>,
): Promise<Decision> => {
  if (actor.isOwner || entry.level !== 'MANAGER') return allow();

  return lockoutIfReaches(actor, entry.subject, reachesActor);
};

/**
 * Taking a grant away: `acl:revoke` and `MANAGER` on the object, nothing more.
 *
 * The scope comes as a thunk, and that is the point of the shape: revocation is addressed by the
 * grant's id, so producing the scope means reading the row first — and a caller without the key
 * must be refused before that read, or «no such grant» and «not yours» would come back differently
 * to somebody who holds nothing. `authorizeWith` asks the thunk only once the capability holds.
 */
export const canRevokeAcl = (
  actor: Actor | null,
  resolveScope: () => Promise<AclScope>,
): Promise<Decision> => authorizeWith(actor, 'acl:revoke', resolveScope);

/** Seeing who has what on an object: `acl:read` and `VIEWER` on it — the object read only after the key. */
export const canReadAcl = (
  actor: Actor | null,
  resolveScope: () => Promise<AclScope>,
): Promise<Decision> => authorizeWith(actor, 'acl:read', resolveScope);
