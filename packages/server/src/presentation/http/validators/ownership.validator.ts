import { userIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The body of an ownership transfer.
 *
 * The story asks the outgoing owner to type the organization's `slug` back as confirmation. That
 * control is **not** in this schema, and the object is strict — sending a `confirmation` field is a
 * 422. Deliberately: a server-side comparison would add nothing an attacker holding the token could
 * not satisfy, while making the operation impossible to script for an installation that wants to.
 * The control exists against a mis-click, and a mis-click happens in a browser, so it belongs to the
 * screen — which is deferred with STORY-012-06 and does not exist yet.
 *
 * `previousOwnerRoleKey` is what the person handing it over keeps. Defaulted rather than optional:
 * an organization whose founder is left unable to open the administration screen has traded one
 * broken state for another.
 */
export const transferOwnershipBodySchema = z.strictObject({
  toUserId: userIdSchema,
  previousOwnerRoleKey: z
    .enum(['admin', 'manager', 'lead', 'developer', 'viewer'])
    .default('admin'),
});
