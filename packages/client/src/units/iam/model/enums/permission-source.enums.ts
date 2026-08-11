import { type SharedPermissions } from '@bad-crm/shared';

/**
 * The layer that decided one permission, as a sentence the interface can show.
 *
 * A written-out map rather than `` `permissions.source.${source}` ``: a key assembled at runtime is
 * invisible to `test/i18n/catalogue-parity.test.ts`, so a missing translation would first be seen
 * on a screen (`rules/i18n.mdc` §3, ADR-0019). Typed `Record<CapabilitySource, …>`, so a rung added
 * to the ladder in `@bad-crm/shared` is a compile error here rather than an untranslated badge.
 *
 * **These name the answer; they never compute it.** `source` arrives from the server, which derives
 * it from the one `capabilityOutcome` the request guard walks (`permission-model.md` §«Слой 5»,
 * «одна лестница, три потребителя»). Nothing in this unit re-derives it.
 */
export const PERMISSION_SOURCE_LABEL_KEY: Readonly<
  Record<SharedPermissions.CapabilitySource, string>
> = {
  OWNER: 'permissions.source.owner',
  OVERRIDE_DENY: 'permissions.source.overrideDeny',
  OVERRIDE_ALLOW: 'permissions.source.overrideAllow',
  ROLE: 'permissions.source.role',
  NOT_GRANTED: 'permissions.source.notGranted',
};

/**
 * Which sources read as a refusal, for the colour of the badge only.
 *
 * Deliberately **not** used to answer «may this person do it» — that is `allowed` in the response,
 * and it is derived from `source` by `sourceAllows` on the server. A second copy of that line here
 * would be the fourth implementation of the capability ladder this story exists to avoid; this map
 * decides a colour, and a wrong colour is a wrong colour.
 */
export const PERMISSION_SOURCE_TONE: Readonly<
  Record<SharedPermissions.CapabilitySource, 'granted' | 'refused'>
> = {
  OWNER: 'granted',
  OVERRIDE_DENY: 'refused',
  OVERRIDE_ALLOW: 'granted',
  ROLE: 'granted',
  NOT_GRANTED: 'refused',
};

/**
 * The three positions of the control, which are the three things an administrator can *choose* —
 * not the five things the server can *report*.
 *
 * The difference is the design: `OWNER` and `NOT_GRANTED` and `ROLE` are all «no personal
 * exception», and offering them as separate choices would ask somebody to pick an outcome they do
 * not control. What they control is whether a row in `UserPermissionOverride` exists and which way
 * it points.
 */
export const PERMISSION_CHOICES = ['ALLOW', 'DENY', 'INHERITED'] as const;

export type PermissionChoice = (typeof PERMISSION_CHOICES)[number];

export const PERMISSION_CHOICE_LABEL_KEY: Readonly<Record<PermissionChoice, string>> = {
  ALLOW: 'permissions.choice.allow',
  DENY: 'permissions.choice.deny',
  INHERITED: 'permissions.choice.inherited',
};
