/**
 * Resource-scoped access levels (layer 4 of the permission model).
 *
 * Source of truth: `docs/security/permission-model.md`, «Слой 4 — resource-scoped ACL».
 */
export const ACCESS_LEVELS = ['NONE', 'VIEWER', 'COMMENTER', 'EDITOR', 'MANAGER'] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** The one place where the order of the scale is written down. */
export const ACCESS_LEVEL_RANK: Readonly<Record<AccessLevel, number>> = {
  NONE: 0,
  VIEWER: 1,
  COMMENTER: 2,
  EDITOR: 3,
  MANAGER: 4,
};

export const atLeast = (actual: AccessLevel, required: AccessLevel): boolean =>
  ACCESS_LEVEL_RANK[actual] >= ACCESS_LEVEL_RANK[required];
