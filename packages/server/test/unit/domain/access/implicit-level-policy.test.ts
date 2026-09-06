import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type Actor } from '@/domain/access/actor.types.js';
import { implicitLevel, type ImplicitLevelFacts } from '@/domain/access/implicit-level.policy.js';

/**
 * §5 of `docs/security/permission-model.md`, «`implicitLevel` — уровень, когда ни одной записи ACL
 * нет», row by row.
 *
 * The table has fifteen rows. Nine of them have a subject in the product today — the organization,
 * the project, and the guest rule that applies to anything — and each of those nine is a case
 * below. The other six (`CHANNEL` ×4, «личный ресурс» ×2) describe kinds of object that do not
 * exist yet; the facts union does not admit them, so the function cannot be asked about them and
 * there is nothing to assert. They are listed at the bottom by name, so that the day a channel or a
 * personal file arrives, the missing cases are a diff of this file and not a memory.
 */

const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';

const actorWith = (roleKeys: readonly string[] = ['developer']): Actor => ({
  userId: IVAN,
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys,
});

const organization = (): ImplicitLevelFacts => ({ resourceType: 'ORGANIZATION' });

const project = (
  visibility: 'PUBLIC_ORG' | 'PRIVATE',
  memberRole: 'LEAD' | 'MEMBER' | 'REVIEWER' | 'OBSERVER' | null,
): ImplicitLevelFacts => ({ resourceType: 'PROJECT', visibility, memberRole });

describe('implicitLevel — the rows of §5 that have a subject today', () => {
  it.each<[string, ImplicitLevelFacts, SharedPermissions.AccessLevel]>([
    ['ORGANIZATION · active member (not guest) → VIEWER', organization(), 'VIEWER'],
    ['PROJECT · projectRole = LEAD → MANAGER', project('PRIVATE', 'LEAD'), 'MANAGER'],
    ['PROJECT · projectRole = MEMBER → EDITOR', project('PRIVATE', 'MEMBER'), 'EDITOR'],
    ['PROJECT · projectRole = REVIEWER → COMMENTER', project('PRIVATE', 'REVIEWER'), 'COMMENTER'],
    ['PROJECT · projectRole = OBSERVER → VIEWER', project('PRIVATE', 'OBSERVER'), 'VIEWER'],
    [
      'PROJECT PUBLIC_ORG · not a member, but of the org → VIEWER',
      project('PUBLIC_ORG', null),
      'VIEWER',
    ],
    ['PROJECT PRIVATE · not a member → NONE (→ 404)', project('PRIVATE', null), 'NONE'],
  ])('%s', (_row, facts, expected) => {
    expect(implicitLevel(actorWith(), facts)).toBe(expected);
  });

  /**
   * Membership beats visibility: a member of a public project is not demoted to the bystander's
   * `VIEWER`. The table says «any» in the `LEAD` row and the reading applies to all four roles.
   */
  it.each<['LEAD' | 'MEMBER' | 'REVIEWER' | 'OBSERVER', SharedPermissions.AccessLevel]>([
    ['LEAD', 'MANAGER'],
    ['MEMBER', 'EDITOR'],
    ['REVIEWER', 'COMMENTER'],
    ['OBSERVER', 'VIEWER'],
  ])('a %s of a PUBLIC_ORG project gets the role level, not the bystander level', (role, level) => {
    expect(implicitLevel(actorWith(), project('PUBLIC_ORG', role))).toBe(level);
  });
});

describe('implicitLevel — the guest rows', () => {
  it('ORGANIZATION · role guest → NONE', () => {
    expect(implicitLevel(actorWith(['guest']), organization())).toBe('NONE');
  });

  /**
   * «Любой ресурс · роль guest → NONE» — the last row of the table, and it beats membership: a
   * guest who is somehow a project lead still sees nothing without an explicit grant. That is the
   * whole meaning of the role (`IMPLICIT_LEVEL_NONE_ROLES` in `packages/shared`).
   */
  it.each<ImplicitLevelFacts>([
    project('PUBLIC_ORG', null),
    project('PUBLIC_ORG', 'LEAD'),
    project('PRIVATE', 'MEMBER'),
  ])('any resource · role guest → NONE (%o)', (facts) => {
    expect(implicitLevel(actorWith(['guest']), facts)).toBe('NONE');
  });

  it('is decided by the guest key being held, whatever else is held beside it', () => {
    expect(implicitLevel(actorWith(['developer', 'guest']), organization())).toBe('NONE');
  });

  it('does not mistake an empty role list for a guest', () => {
    expect(implicitLevel(actorWith([]), organization())).toBe('VIEWER');
  });
});

describe('implicitLevel — what it deliberately does not decide', () => {
  /**
   * Rule 5 of the resolution («владелец получает MANAGER без обхода — кроме vault») is not a row of
   * the implicit table and is not applied here: `authorizeResource` clears the level for the owner
   * in the one place that also knows the family of the object. Applying it here as well would be
   * the second point of the same decision, and the two would disagree the first time the vault
   * exception was edited in one of them. So the owner reads the table like everybody else.
   */
  it('reads the table for the owner too — the bypass lives in authorizeResource', () => {
    const owner: Actor = { ...actorWith(), isOwner: true };

    expect(implicitLevel(owner, project('PRIVATE', null))).toBe('NONE');
  });

  /**
   * The six rows without a subject, by name. Not `it.todo`: a todo is a promise this file makes,
   * and the promise belongs to the epic that creates the object.
   *
   *   - `CHANNEL kind = PUBLIC` · member of the organization → `COMMENTER`
   *   - `CHANNEL kind = PRIVATE|DM|GROUP_DM` · `ChannelMember.role = ADMIN` → `MANAGER`
   *   - `CHANNEL kind = PRIVATE|DM|GROUP_DM` · `ChannelMember` (MEMBER) → `COMMENTER`
   *   - `CHANNEL` private · not a member → `NONE`
   *   - personal resource (`File.scope = PERSONAL`, `Vault.kind = PERSONAL`, draft `DocPage`) · owner → `MANAGER`
   *   - personal resource · not the owner → `NONE`
   */
  it('admits only the two kinds of facts the product can produce', () => {
    // Exhaustive by type, not by count: a third member of the union makes this object fail to
    // compile, which is the failure wanted — a list written by hand would keep passing.
    const kinds: Record<ImplicitLevelFacts['resourceType'], true> = {
      ORGANIZATION: true,
      PROJECT: true,
    };

    expect(Object.keys(kinds).sort()).toEqual(['ORGANIZATION', 'PROJECT']);
  });
});
