/* eslint-disable bad-crm/require-role-suffix --
 * `.catalog` is not in the closed suffix dictionary of rules/naming-and-structure.mdc, but this
 * exact path is mandated by a higher source of truth: invariant 2 in CLAUDE.md and
 * docs/security/permission-model.md §1 both name
 * `packages/shared/src/permissions/permissions.catalog.ts` as *the* permission catalog, and the
 * `permission-matrix-auditor` agent looks for it there. Renaming the file to satisfy the linter
 * would break the normative reference; adding `.catalog` to the dictionary is a change to
 * rules/naming-and-structure.mdc and belongs to the person who owns that rule file.
 */
import type { AccessLevel } from './access-level.enums.js';

/**
 * Layer 1 of the permission model: the closed catalog of permission keys.
 *
 * ⚠️ STUB — this is the structure plus a representative slice, not the full catalog. The complete
 * list of 318 keys is populated by [EPIC-011](../../../../epics/epic-011-rbac-permissions/epic.md)
 * straight from the tables in `docs/security/permission-model.md` §3, which stays the source of
 * truth. Keys are added there first and copied here, never invented at a call site.
 *
 * Rules that already apply to every key in this file
 * (docs/security/permission-model.md §1):
 *
 * 1. A permission exists only if some use-case checks it.
 * 2. Keys are never reused: a removed key does not come back with a different meaning, or historic
 *    `RolePermission` rows and `AuditLog` entries start meaning something else.
 * 3. `requiredLevel` lives in code only — it is a property of the logic, not of the data, and it
 *    changes together with the use-case.
 */
export const PERMISSIONS = [
  'organization:read',
  'organization:update',
  'organization:export_data',
  'organization:delete',
  'user:read',
  'user:invite',
  'user:suspend',
  'role:read',
  'role:assign',
  'permission:override',
  'project:read',
  'project:create',
  'project:update',
  'project:delete',
  'task:read',
  'task:create',
  'task:update',
  'task:move',
  'vault_item:read',
  'vault_item:decrypt',
  'audit:read',
  'audit:export',
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];

/** Bounded contexts the keys are grouped by (docs/architecture/overview.md). */
export const PERMISSION_DOMAINS = [
  'organization',
  'iam',
  'project',
  'task',
  'knowledge',
  'file',
  'vault',
  'secure-link',
  'time',
  'communication',
  'analytics',
  'integration',
  'ai',
  'delivery',
  'platform',
] as const;

export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

export interface PermissionMeta {
  /** Part of the key before the colon. */
  readonly resource: string;
  /** Part of the key after the colon. */
  readonly action: string;
  readonly domain: PermissionDomain;
  /** `null` — the permission is organization-scoped and needs no resource ACL. */
  readonly requiredLevel: AccessLevel | null;
  /** Needs confirmation in the UI, a louder audit record and attention at review. */
  readonly dangerous: boolean;
  /** An i18n key, not a ready-made sentence: the description is translated (rules/i18n.mdc). */
  readonly descriptionKey: string;
  /** Set when a key is retired. The string stays for the sake of readable historic dumps. */
  readonly deprecated?: { readonly since: string; readonly replacedBy?: PermissionKey };
}

export const PERMISSION_META: Readonly<Record<PermissionKey, PermissionMeta>> = {
  'organization:read': {
    resource: 'organization',
    action: 'read',
    domain: 'organization',
    requiredLevel: null,
    dangerous: false,
    descriptionKey: 'permission.organization.read',
  },
  'organization:update': {
    resource: 'organization',
    action: 'update',
    domain: 'organization',
    requiredLevel: 'MANAGER',
    dangerous: false,
    descriptionKey: 'permission.organization.update',
  },
  'organization:export_data': {
    resource: 'organization',
    action: 'export_data',
    domain: 'organization',
    requiredLevel: 'MANAGER',
    dangerous: true,
    descriptionKey: 'permission.organization.export_data',
  },
  'organization:delete': {
    resource: 'organization',
    action: 'delete',
    domain: 'organization',
    requiredLevel: 'MANAGER',
    dangerous: true,
    descriptionKey: 'permission.organization.delete',
  },
  'user:read': {
    resource: 'user',
    action: 'read',
    domain: 'iam',
    requiredLevel: null,
    dangerous: false,
    descriptionKey: 'permission.user.read',
  },
  'user:invite': {
    resource: 'user',
    action: 'invite',
    domain: 'iam',
    requiredLevel: null,
    dangerous: false,
    descriptionKey: 'permission.user.invite',
  },
  'user:suspend': {
    resource: 'user',
    action: 'suspend',
    domain: 'iam',
    requiredLevel: null,
    dangerous: true,
    descriptionKey: 'permission.user.suspend',
  },
  'role:read': {
    resource: 'role',
    action: 'read',
    domain: 'iam',
    requiredLevel: null,
    dangerous: false,
    descriptionKey: 'permission.role.read',
  },
  'role:assign': {
    resource: 'role',
    action: 'assign',
    domain: 'iam',
    requiredLevel: null,
    dangerous: true,
    descriptionKey: 'permission.role.assign',
  },
  'permission:override': {
    resource: 'permission',
    action: 'override',
    domain: 'iam',
    requiredLevel: null,
    dangerous: true,
    descriptionKey: 'permission.permission.override',
  },
  'project:read': {
    resource: 'project',
    action: 'read',
    domain: 'project',
    requiredLevel: 'VIEWER',
    dangerous: false,
    descriptionKey: 'permission.project.read',
  },
  'project:create': {
    resource: 'project',
    action: 'create',
    domain: 'project',
    requiredLevel: null,
    dangerous: false,
    descriptionKey: 'permission.project.create',
  },
  'project:update': {
    resource: 'project',
    action: 'update',
    domain: 'project',
    requiredLevel: 'EDITOR',
    dangerous: false,
    descriptionKey: 'permission.project.update',
  },
  'project:delete': {
    resource: 'project',
    action: 'delete',
    domain: 'project',
    requiredLevel: 'MANAGER',
    dangerous: true,
    descriptionKey: 'permission.project.delete',
  },
  'task:read': {
    resource: 'task',
    action: 'read',
    domain: 'task',
    requiredLevel: 'VIEWER',
    dangerous: false,
    descriptionKey: 'permission.task.read',
  },
  'task:create': {
    resource: 'task',
    action: 'create',
    domain: 'task',
    requiredLevel: 'EDITOR',
    dangerous: false,
    descriptionKey: 'permission.task.create',
  },
  'task:update': {
    resource: 'task',
    action: 'update',
    domain: 'task',
    requiredLevel: 'EDITOR',
    dangerous: false,
    descriptionKey: 'permission.task.update',
  },
  'task:move': {
    resource: 'task',
    action: 'move',
    domain: 'task',
    requiredLevel: 'EDITOR',
    dangerous: false,
    descriptionKey: 'permission.task.move',
  },
  'vault_item:read': {
    resource: 'vault_item',
    action: 'read',
    domain: 'vault',
    requiredLevel: 'VIEWER',
    dangerous: false,
    descriptionKey: 'permission.vault_item.read',
  },
  'vault_item:decrypt': {
    resource: 'vault_item',
    action: 'decrypt',
    domain: 'vault',
    requiredLevel: 'VIEWER',
    dangerous: true,
    descriptionKey: 'permission.vault_item.decrypt',
  },
  'audit:read': {
    resource: 'audit',
    action: 'read',
    domain: 'platform',
    requiredLevel: null,
    dangerous: false,
    descriptionKey: 'permission.audit.read',
  },
  'audit:export': {
    resource: 'audit',
    action: 'export',
    domain: 'platform',
    requiredLevel: null,
    dangerous: true,
    descriptionKey: 'permission.audit.export',
  },
};

export const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export const isPermissionKey = (value: string): value is PermissionKey => PERMISSION_SET.has(value);

/** `null` means the key carries no resource context; `undefined` is not a possible answer. */
export const requiredLevel = (key: PermissionKey): AccessLevel | null =>
  PERMISSION_META[key].requiredLevel;
