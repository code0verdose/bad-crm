import { type RoleListEntry } from '@/application/iam/ports/role-repository.port.js';
import { type CreatedRole } from '@/application/iam/use-cases/write-custom-role.use-case.js';
import { type RoleChangeOutcome } from '@/application/iam/use-cases/write-role-changes.use-case.js';

/**
 * Role results → the schemas of `docs/api/openapi.yaml`.
 *
 * The composition goes back on the wire because the screen that sent it needs the identifier to
 * address the role afterwards, and returning the whole thing rather than the id alone means the
 * client never has to guess whether what it sent is what was stored — a role whose composition was
 * narrowed on the way in would otherwise be indistinguishable from one that was not.
 *
 * `isSystem` is a constant here, and deliberately present: a role created through the API is never
 * a system role, and a client reading the field does not have to know that rule to render the
 * «cannot be edited» state consistently for every role it holds.
 */
export interface RoleResponse {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
}

export const serializeCreatedRole = (role: CreatedRole): RoleResponse => ({
  id: role.roleId,
  key: role.key,
  name: role.name,
  description: role.description,
  isSystem: false,
  permissions: [...role.permissions],
});

/**
 * One row of the administration matrix.
 *
 * `holderCount`, not the holders: the screen needs «how many people does this change affect» before
 * every edit, and a list of names would be a second permission's worth of data attached to a read
 * that only asked about roles.
 */
export interface RoleListEntryResponse extends RoleResponse {
  readonly isDefault: boolean;
  readonly holderCount: number;
}

export const serializeRole = (role: RoleListEntry): RoleListEntryResponse => ({
  id: role.roleId,
  key: role.key,
  name: role.name,
  description: role.description,
  isSystem: role.isSystem,
  isDefault: role.isDefault,
  holderCount: role.holderCount,
  permissions: [...role.permissions],
});

/**
 * One row of «what would happen if I saved this».
 *
 * `reason` travels as a plain code and `null` means «this one would be accepted»: the screen greys
 * a cell out and explains why in its own language, which it can only do if the server names the
 * refusal rather than describing it.
 */
export interface RoleChangeOutcomeResponse {
  readonly roleId: string;
  readonly key: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly holderCount: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly dangerous: readonly string[];
  readonly reason: string | null;
}

export const serializeRoleChangeOutcome = (
  outcome: RoleChangeOutcome,
): RoleChangeOutcomeResponse => ({
  roleId: outcome.roleId,
  key: outcome.key,
  name: outcome.name,
  isSystem: outcome.isSystem,
  holderCount: outcome.holderCount,
  added: [...outcome.added],
  removed: [...outcome.removed],
  dangerous: [...outcome.dangerous],
  reason: outcome.reason,
});
