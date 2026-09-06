import { SharedPermissions } from '@bad-crm/shared';

import { type Actor } from '@/domain/access/actor.types.js';

export type ProjectRole = 'LEAD' | 'MEMBER' | 'REVIEWER' | 'OBSERVER';
export type ProjectVisibility = 'PUBLIC_ORG' | 'PRIVATE';

/**
 * The facts the implicit table reads, per kind of object — and only the kinds that exist.
 *
 * A discriminated union rather than a bag of optional fields, so that «what does the table need to
 * know about a channel» is a compile-time question the day a channel arrives: adding `CHANNEL` here
 * without a branch below does not build. The two members are the two kinds of object the product
 * has (`docs/architecture/data-model.md` §3); the six rows of §5 about channels and personal
 * resources have no member yet and are listed in `implicit-level-policy.test.ts` by name, so they
 * are a diff and not a memory.
 */
export type ImplicitLevelFacts =
  | { readonly resourceType: 'ORGANIZATION' }
  | {
      readonly resourceType: 'PROJECT';
      readonly visibility: ProjectVisibility;
      /** The actor's live membership (`left_at IS NULL`), or `null` when they are not on the project. */
      readonly memberRole: ProjectRole | null;
    };

const PROJECT_ROLE_LEVEL: Readonly<Record<ProjectRole, SharedPermissions.AccessLevel>> = {
  LEAD: 'MANAGER',
  MEMBER: 'EDITOR',
  REVIEWER: 'COMMENTER',
  OBSERVER: 'VIEWER',
};

/**
 * The level an actor holds on an object when **no** ACL entry exists anywhere on its chain —
 * `docs/security/permission-model.md` §5, «`implicitLevel` — уровень, когда ни одной записи ACL
 * нет», applied row by row.
 *
 * Not «allowed to everybody»: the formalisation of membership. A `ProjectMember` row is already a
 * form of access, and duplicating it as `ResourceAcl` rows would drift the first time somebody
 * left a project without the duplicate being removed (§5, the paragraph under the table).
 *
 * **The guest row is read from `actor.roleKeys`, and that is the one sanctioned reading of it.**
 * `actor.types.ts` says no policy may decide by a role name, and the reason is sound — «is a
 * manager» is not a permission. The guest role is the exception the model itself makes: §5's last
 * row says «любой ресурс · роль guest → NONE», and `packages/shared` exports
 * `IMPLICIT_LEVEL_NONE_ROLES` for exactly this reading and nothing else. What makes it not a second
 * point of truth is that it does not *grant*: it only says that for this role silence is silence,
 * and every capability the guest holds still needs an explicit grant to reach an object.
 *
 * **The owner is not a row here on purpose.** Rule 5 of the resolution («владелец получает MANAGER
 * без обхода — кроме vault») is applied by `authorizeResource`, the one place that also knows the
 * family of the object; a second copy here would disagree with it the first time the vault
 * exception was edited in one of them.
 */
export const implicitLevel = (
  actor: Actor,
  facts: ImplicitLevelFacts,
): SharedPermissions.AccessLevel => {
  if (isImplicitlyNone(actor)) return 'NONE';

  switch (facts.resourceType) {
    case 'ORGANIZATION':
      return 'VIEWER';
    case 'PROJECT':
      if (facts.memberRole !== null) return PROJECT_ROLE_LEVEL[facts.memberRole];

      return facts.visibility === 'PUBLIC_ORG' ? 'VIEWER' : 'NONE';
  }
};

const IMPLICIT_NONE: ReadonlySet<string> = new Set<string>(
  SharedPermissions.IMPLICIT_LEVEL_NONE_ROLES,
);

const isImplicitlyNone = (actor: Actor): boolean =>
  actor.roleKeys.some((key) => IMPLICIT_NONE.has(key));
