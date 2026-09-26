import { randomUUID } from 'node:crypto';

import { type SharedPermissions } from '@bad-crm/shared';

import {
  type AclEntryDraft,
  type AclEntryRow,
  type AclListEntry,
  type AclRepositoryPort,
} from '@/application/access/ports/acl-repository.port.js';
import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type AclResourceRef, type AclSubjectRef } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type AclScope } from '@/domain/access/authorize.util.js';

export const ids = {
  ORG: '018f4a3b-0000-7000-8000-0000000000a1',
  IVAN: '018f4a3b-0000-7000-8000-0000000000c1',
  PETR: '018f4a3b-0000-7000-8000-0000000000c2',
  PROJECT: '018f4a3b-0000-7000-8000-0000000000d1',
  TEAM: '018f4a3b-0000-7000-8000-0000000000e1',
} as const;

export const actorWith = (granted: readonly SharedPermissions.PermissionKey[] = []): Actor => ({
  userId: ids.IVAN,
  organizationId: ids.ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(granted),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
});

/** When every seeded grant was given — the fake keeps no clock of its own. */
export const GRANTED_AT = new Date('2026-09-06T12:00:00.000Z');

const keyOf = (ref: AclResourceRef | AclSubjectRef): string => `${ref.type}:${ref.id}`;

/** A resolver that answers one scope, whatever it is asked — the use-case tests are about what follows. */
export class FakeAclResolver implements AclScopeResolver {
  readonly asked: { actor: Actor; ref: AclResourceRef }[] = [];

  constructor(private readonly scope: AclScope) {}

  resolve(actor: Actor, ref: AclResourceRef): Promise<AclScope> {
    this.asked.push({ actor, ref });

    return Promise.resolve(this.scope);
  }
}

/**
 * The grants of one tenant, in memory, with the two facts about subjects the commands ask for.
 *
 * Every subject exists unless it is in `missingSubjects`, and stands for the accounts in
 * `subjects` (none, by default — a team with nobody on it is a valid subject that bumps nobody).
 */
export class FakeAclRepository implements AclRepositoryPort {
  readonly rows: AclEntryRow[] = [];
  readonly bumped: (readonly string[])[] = [];
  readonly existenceChecks: AclSubjectRef[] = [];
  readonly finds: { resource: AclResourceRef; subject: AclSubjectRef }[] = [];
  /** Every grant id a command looked up — empty when the capability refused first. */
  readonly idLookups: string[] = [];
  /** Every list the query asked for, with the instant it asked at. */
  readonly listed: { resource: AclResourceRef; now: Date }[] = [];
  readonly missingSubjects = new Set<string>();
  readonly subjects = new Map<string, readonly string[]>();
  /** Every «does this role or team reach this person» the commands asked, in order. */
  readonly reachChecks: { subject: AclSubjectRef; userId: string }[] = [];

  seed(row: Omit<AclEntryRow, 'id'>): string {
    const id = randomUUID();

    this.rows.push({ id, ...row });

    return id;
  }

  find(resource: AclResourceRef, subject: AclSubjectRef): Promise<AclEntryRow | null> {
    this.finds.push({ resource, subject });

    return Promise.resolve(
      this.rows.find(
        (row) => keyOf(row.resource) === keyOf(resource) && keyOf(row.subject) === keyOf(subject),
      ) ?? null,
    );
  }

  /**
   * Runs once a `findById` found its row, before the caller acts on it — the window a concurrent
   * revocation or re-grant of the same id lands in (the gate's L-1).
   */
  afterFindById: ((found: AclEntryRow) => void) | undefined;

  findById(id: string): Promise<AclEntryRow | null> {
    this.idLookups.push(id);

    const found = this.rows.find((row) => row.id === id) ?? null;

    if (found !== null) this.afterFindById?.(found);

    return Promise.resolve(found);
  }

  /** In seeding order, live at `now` — the adapter's `ORDER BY` and `expires_at` predicate, in memory. */
  listOn(resource: AclResourceRef, now: Date): Promise<readonly AclListEntry[]> {
    this.listed.push({ resource, now });

    return Promise.resolve(
      this.rows
        .filter(
          (row) =>
            keyOf(row.resource) === keyOf(resource) &&
            (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()),
        )
        .map((row) => ({ ...row, grantedAt: GRANTED_AT })),
    );
  }

  upsert(draft: AclEntryDraft): Promise<string> {
    const index = this.rows.findIndex(
      (row) =>
        keyOf(row.resource) === keyOf(draft.resource) &&
        keyOf(row.subject) === keyOf(draft.subject),
    );
    const id = index === -1 ? randomUUID() : (this.rows[index]?.id ?? randomUUID());
    const row: AclEntryRow = { id, ...draft };

    if (index === -1) this.rows.push(row);
    else this.rows[index] = row;

    return Promise.resolve(id);
  }

  /** The row as it stood when it went, or `null` — the adapter's `DELETE … RETURNING`, in memory. */
  removeById(id: string): Promise<AclEntryRow | null> {
    const index = this.rows.findIndex((row) => row.id === id);

    if (index === -1) return Promise.resolve(null);

    const [removed] = this.rows.splice(index, 1);

    return Promise.resolve(removed ?? null);
  }

  removeAllOfSubject(subject: AclSubjectRef): Promise<readonly AclEntryRow[]> {
    const removed = this.rows.filter((row) => keyOf(row.subject) === keyOf(subject));

    for (const row of removed) this.rows.splice(this.rows.indexOf(row), 1);

    return Promise.resolve(removed);
  }

  subjectExists(subject: AclSubjectRef): Promise<boolean> {
    this.existenceChecks.push(subject);

    return Promise.resolve(!this.missingSubjects.has(keyOf(subject)));
  }

  /** A role or a team reaches the person when `subjects` lists them — the reader's match, in memory. */
  subjectReaches(subject: AclSubjectRef, userId: string): Promise<boolean> {
    this.reachChecks.push({ subject, userId });

    return Promise.resolve((this.subjects.get(keyOf(subject)) ?? []).includes(userId));
  }

  subjectUserIds(subject: AclSubjectRef): Promise<readonly string[]> {
    return Promise.resolve(this.subjects.get(keyOf(subject)) ?? []);
  }

  bumpPermissionsVersionOf(userIds: readonly string[]): Promise<void> {
    this.bumped.push(userIds);

    return Promise.resolve();
  }
}
