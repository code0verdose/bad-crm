import { PERMISSIONS, SYSTEM_ROLE_KEYS } from '@bad-crm/shared/permissions';
import { roleIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The request schemas of the custom-role surface.
 *
 * `permissions` is a `z.enum` over the catalogue, so a key nobody declared never reaches a policy:
 * `can()` fails closed on an unknown key, which would refuse everybody at runtime instead of
 * refusing the author at the boundary.
 */

const KEY_MAX = 64;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

const permissionKeySchema = z.enum(PERMISSIONS as unknown as [string, ...string[]], {
  error: 'validation.permissionKey.unknown',
});

/**
 * `tech_writer`, not `Tech Writer`: the key is an identifier the interface renders through a label,
 * and a key with spaces or case is the kind of value that reads fine until somebody puts it in a URL.
 */
const roleKeySchema = z
  .string({ error: 'validation.roleKey.invalid' })
  .trim()
  .regex(/^[a-z][a-z0-9_]*$/, { error: 'validation.roleKey.invalid' })
  .max(KEY_MAX, { error: 'validation.roleKey.too_long' })
  /**
   * The keys of the system roles are reserved, and this is not tidiness.
   *
   * Provisioning re-applies the system matrix on every upgrade by key: a custom role called
   * `manager` would be found by that upsert and rewritten — name, composition and all — for everyone
   * holding it, with no trail and no way back except a backup. Refusing the key at creation is the
   * only moment at which the collision costs nothing.
   */
  .refine((key) => !(SYSTEM_ROLE_KEYS as readonly string[]).includes(key), {
    error: 'validation.roleKey.reserved',
  });

const compositionShape = {
  name: z
    .string({ error: 'validation.roleName.invalid' })
    .trim()
    .min(1, { error: 'validation.roleName.invalid' })
    .max(NAME_MAX, { error: 'validation.roleName.too_long' }),
  description: z.string().trim().max(DESCRIPTION_MAX).nullish(),
  /**
   * Deduplicated at the boundary. A key repeated in the body means the same role, and letting the
   * repeat through would break the unique index — which the translator turns into
   * `role_already_exists`, an answer about the *key of the role* that has nothing to do with what
   * actually happened.
   */
  permissions: z
    .array(permissionKeySchema)
    .max(PERMISSIONS.length)
    .transform((keys) => [...new Set(keys)]),
};

export const createRoleBodySchema = z.strictObject({ key: roleKeySchema, ...compositionShape });

export const updateRoleBodySchema = z.strictObject(compositionShape);

export const roleIdParamsSchema = z.strictObject({ roleId: roleIdSchema });

/**
 * A draft of the administration matrix: one entry per role, each carrying the composition the role
 * should end up with — not a delta.
 *
 * The whole composition for the same reason the single-role edit takes one: a delta needs the server
 * to know which version the screen was looking at, and the answer to «what should this role grant»
 * is the only thing the administrator actually decided.
 */
const MAX_ROLES_PER_DRAFT = 64;

export const roleChangesBodySchema = z.strictObject({
  changes: z
    .array(
      z.strictObject({
        roleId: roleIdSchema,
        permissions: z
          .array(permissionKeySchema)
          .max(PERMISSIONS.length)
          .transform((keys) => [...new Set(keys)]),
      }),
    )
    .min(1, { error: 'validation.roleChanges.empty' })
    .max(MAX_ROLES_PER_DRAFT, { error: 'validation.roleChanges.too_many' })
    // The same role twice would make «what should it grant» ambiguous, and picking either answer
    // silently is how a screen and a database stop agreeing.
    .refine((changes) => new Set(changes.map((change) => change.roleId)).size === changes.length, {
      error: 'validation.roleChanges.duplicate_role',
    }),
});
