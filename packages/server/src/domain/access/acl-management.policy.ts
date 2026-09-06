import { type AclGrantDraft } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { authorize, type AclScope } from '@/domain/access/authorize.util.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, deny } from '@/domain/access/decision.util.js';

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
 * One rule is specific to granting and sits on top — **no locking oneself out**: a `NONE` on one's
 * own `USER` entry is refused as `self_lockout`, the way denying oneself `permission:override` is.
 * A `NONE` on a team the actor belongs to is the same outcome and is *not* refused here — the
 * policy does not know the actor's teams, and a membership read on the path of every grant is the
 * wrong price for one rule; the recourse the model gives everybody else (a closer node, another
 * manager) stays.
 *
 * The owner passes: ownership replaces the layers rather than enumerating them, and nothing can
 * lock the owner out by construction (`authorizeResource`).
 */
export const canGrantAcl = (actor: Actor, scope: AclScope, draft: AclGrantDraft): Decision => {
  const conjunction = authorize(actor, 'acl:grant', scope);

  if (!conjunction.allowed) return conjunction;
  if (actor.isOwner) return allow();

  if (
    draft.subject.type === 'USER' &&
    draft.subject.id === actor.userId &&
    draft.level === 'NONE'
  ) {
    return deny('self_lockout');
  }

  return allow();
};

/** Taking a grant away: `acl:revoke` and `MANAGER` on the object, nothing more. */
export const canRevokeAcl = (actor: Actor | null, scope: AclScope): Decision =>
  authorize(actor, 'acl:revoke', scope);

/** Seeing who has what on an object: `acl:read` and `VIEWER` on it. */
export const canReadAcl = (actor: Actor | null, scope: AclScope): Decision =>
  authorize(actor, 'acl:read', scope);
