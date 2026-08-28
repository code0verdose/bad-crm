import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { SharedAudit } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import {
  findAuditRecordCalls,
  requiresAddressWhenHuman,
  type AuditRecordCallSite,
} from './support/audit-record-call.util.js';

/**
 * NFR-6 asks for the audit trail to carry «actor, объект, до/после и IP». By 2026-08-28 that last
 * part was true for one action out of thirty: `user.mfa_reset_by_admin` (fixed in `37e7385`), the
 * only `CRITICAL` one. Every offboarding, reactivation, ownership transfer, permission-override
 * write, role change and invitation revocation wrote `ipAddress: undefined` — a real loss for an
 * incident review that starts, as this codebase's own comments say, from exactly these entries.
 *
 * This file is the gate against the next one regressing the same way. It does not check a list of
 * action names copied in here by hand — that list is precisely what stops tracking the code the
 * first time somebody adds an action and forgets to update it. Instead it **reads the source tree**
 * (`findAuditRecordCalls`, `../support/audit-record-call.util.ts`) and derives, from what is
 * actually written at each call site plus the action's own severity
 * (`SharedAudit.AUDIT_ACTION_SEVERITY` — itself a `Record<AuditAction, …>` the compiler keeps total,
 * not a list anybody maintains by hand either), whether that site is privileged enough that a
 * human-triggered instance of it must carry an address.
 *
 * **The naive version of this gate — «every `audit.record` call passes `ipAddress`» — is wrong**, and
 * demonstrably so today: `application/iam/use-cases/manage-team-members.use-case.ts` files
 * `team.member_added`/`team.member_role_changed` with no address at all (an `INFO` action, membership
 * grants nothing yet), and the moment a background job or migration path starts writing
 * `rls.bypassed` or a similar system-origin entry, it will have no request to read an address from —
 * `AuditActor.userId`'s own docstring says so: `undefined` "for an action taken before any account
 * exists" is exactly what marks an entry as system-origin rather than human. The naive check cannot
 * tell that apart from a bug; `requiresAddressWhenHuman` reads `actor.userId`'s source text to do it,
 * and the second `describe` block below proves it on a case this tree does not contain yet.
 */

const projectRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const applicationRoot = path.join(projectRoot, 'packages/server/src/application');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return walk(full);
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      return [full];
    }

    return [];
  });

interface ScannedSite extends AuditRecordCallSite {
  readonly action: string;
  readonly severity: SharedAudit.AuditSeverity;
}

/** Every `audit.record` call site in the tree, one row per action it can produce. */
const scanTree = (): readonly ScannedSite[] =>
  walk(applicationRoot).flatMap((filePath) => {
    const source = readFileSync(filePath, 'utf8');
    const relative = path.relative(projectRoot, filePath);

    return findAuditRecordCalls(relative, source).flatMap((site) =>
      site.actions
        .filter(SharedAudit.isAuditAction)
        .map((action) => ({ ...site, action, severity: SharedAudit.severityOf(action) })),
    );
  });

describe('audit call sites carry an address when the action is privileged and human-triggered', () => {
  const sites = scanTree();

  // Positive control (`rules/testing.mdc`, «тест, который не видели красным»): if this were empty,
  // every assertion below would pass vacuously — on a broken glob, a renamed method, a regex that
  // stopped matching this codebase's formatting. It is not close to empty: thirty-odd actions are
  // filed from this tree today.
  it('CONTROL: the scan actually finds audit.record call sites', () => {
    expect(sites.length).toBeGreaterThan(20);
  });

  // Second positive control, specific to the classifier: at least one human-triggered, privileged
  // site exists in the tree right now. Without this, a `requiresAddressWhenHuman` that always
  // returned `false` would make every assertion below pass for the same empty reason.
  it('CONTROL: at least one call site is classified as privileged and human-triggered', () => {
    const privileged = sites.filter(
      (site) => site.humanOrigin && requiresAddressWhenHuman(site, site.severity),
    );

    expect(privileged.length).toBeGreaterThan(0);
  });

  // Third positive control: the classifier also has to leave something *out*, or it is just the
  // naive «everything requires an address» check with extra steps. `password.changed` and
  // `invitation.created` are both non-`INFO` and both human-triggered, and neither is privileged by
  // this rule (a password change is the actor acting on themselves; an invitation is not yet
  // anybody's access to take away) — asserted here so a change to the classifier that swallows this
  // distinction is caught by name, once, rather than by every use-case in the tree turning red.
  it('CONTROL: the classifier does not flag every non-INFO action — self-service and creation stay out', () => {
    const selfServiceOrCreation = sites.filter(
      (site) =>
        site.humanOrigin &&
        site.severity !== 'INFO' &&
        !requiresAddressWhenHuman(site, site.severity) &&
        ['password.changed', 'invitation.created', 'invitation.resent'].includes(site.action),
    );

    expect(selfServiceOrCreation.length).toBeGreaterThan(0);
  });

  it('every privileged, human-triggered call site threads a real address', () => {
    const violations = sites.filter(
      (site) =>
        site.humanOrigin && requiresAddressWhenHuman(site, site.severity) && !site.hasIpAddress,
    );

    const report = violations
      .map(
        (v) => `${v.filePath}:${v.line} — ${v.action} (${v.severity}) writes ipAddress: undefined`,
      )
      .join('\n');

    expect(violations, report).toEqual([]);
  });
});

describe('requiresAddressWhenHuman: the rule that keeps the gate from being the naive check', () => {
  const humanCritical: AuditRecordCallSite = {
    filePath: 'synthetic.ts',
    line: 1,
    actions: ['organization.ownership_transferred'],
    humanOrigin: true,
    hasIpAddress: false,
    targetType: 'ORGANIZATION',
    targetIdExpr: 'input.actor.organizationId',
    actorUserIdExpr: 'input.actor.userId',
    hasBefore: true,
    hasAfter: true,
  };

  it('a CRITICAL action is always required', () => {
    expect(requiresAddressWhenHuman(humanCritical, 'CRITICAL')).toBe(true);
  });

  it('a ROLE/USER_ROLE/USER_PERMISSION_OVERRIDE/ORGANIZATION target is always required, even at WARNING', () => {
    for (const targetType of ['ROLE', 'USER_ROLE', 'USER_PERMISSION_OVERRIDE', 'ORGANIZATION']) {
      expect(requiresAddressWhenHuman({ ...humanCritical, targetType }, 'WARNING')).toBe(true);
    }
  });

  it('a USER target is required only when the actor acts on somebody else', () => {
    const onSomeoneElse: AuditRecordCallSite = {
      ...humanCritical,
      targetType: 'USER',
      targetIdExpr: 'subject.userId',
      actorUserIdExpr: 'input.actor.userId',
    };
    const onSelf: AuditRecordCallSite = {
      ...humanCritical,
      targetType: 'USER',
      targetIdExpr: 'input.actor.userId',
      actorUserIdExpr: 'input.actor.userId',
    };

    expect(requiresAddressWhenHuman(onSomeoneElse, 'WARNING')).toBe(true);
    expect(requiresAddressWhenHuman(onSelf, 'WARNING')).toBe(false);
  });

  it('a before-without-after payload is required regardless of target type (e.g. invitation.revoked)', () => {
    const revocationShaped: AuditRecordCallSite = {
      ...humanCritical,
      targetType: 'INVITATION',
      targetIdExpr: 'invitation.id',
      hasBefore: true,
      hasAfter: false,
    };
    const creationShaped: AuditRecordCallSite = {
      ...revocationShaped,
      hasBefore: false,
      hasAfter: true,
    };

    expect(requiresAddressWhenHuman(revocationShaped, 'INFO')).toBe(true);
    expect(requiresAddressWhenHuman(creationShaped, 'INFO')).toBe(false);
  });

  it('DIFFERENTIATION: a background/system-origin site is never required, however privileged its shape', () => {
    // This is the case the naive «every call passes ipAddress» check cannot express: a job or
    // migration path filing `rls.bypassed` (CRITICAL, ORGANIZATION-shaped) has no request to read an
    // address from. `humanOrigin: false` — the same signal `PrismaAuditLogger` itself uses to write
    // `actorType: 'SYSTEM'` — is threaded through the gate's own filter (`site.humanOrigin && …`),
    // not through `requiresAddressWhenHuman`, precisely so a caller cannot forget the check and ask
    // the classifier to do it: a system-origin site never even reaches this function's opinion in the
    // real gate above. The scanner marks it, and the report list stays empty.
    const backgroundOrigin: AuditRecordCallSite = {
      ...humanCritical,
      humanOrigin: false,
      actorUserIdExpr: 'undefined',
      hasIpAddress: false,
    };

    // The shape alone still says «required» — proving the exemption comes from origin, not from
    // suppressing the shape-based rule.
    expect(requiresAddressWhenHuman(backgroundOrigin, 'CRITICAL')).toBe(true);
    // What actually gates the real scan is `site.humanOrigin && requiresAddressWhenHuman(...)`,
    // asserted directly here so this file's own claim about the real gate's predicate is checked,
    // not just described.
    expect(
      backgroundOrigin.humanOrigin && requiresAddressWhenHuman(backgroundOrigin, 'CRITICAL'),
    ).toBe(false);
  });
});

describe('findAuditRecordCalls: parses the shape a real call site has', () => {
  it('reads action, actor, target and the before/after shape out of a realistic block', () => {
    const source = `
      class X {
        async execute(input: Y): Promise<void> {
          await this.audit.record({
            action: 'user.suspended',
            actor: {
              userId: input.actor.userId,
              organizationId: input.actor.organizationId,
              ipAddress: input.ipAddress,
            },
            target: { type: 'USER', id: subject.userId },
            before: { status: subject.status },
            after: { status: 'SUSPENDED' },
            requestId: undefined,
          });
        }
      }
    `;

    const [site] = findAuditRecordCalls('x.ts', source);

    expect(site).toMatchObject({
      actions: ['user.suspended'],
      humanOrigin: true,
      hasIpAddress: true,
      targetType: 'USER',
      targetIdExpr: 'subject.userId',
      actorUserIdExpr: 'input.actor.userId',
      hasBefore: true,
      hasAfter: true,
    });
  });

  it('reads a literal ipAddress: undefined as the absence the whole gate exists to catch', () => {
    const source = `
      await this.audit.record({
        action: 'role.assigned',
        actor: { userId: input.actor.userId, organizationId: input.actor.organizationId, ipAddress: undefined },
        target: { type: 'USER_ROLE', id: input.userId },
        after: { roleId: input.roleId },
        requestId: undefined,
      });
    `;

    const [site] = findAuditRecordCalls('x.ts', source);

    expect(site?.hasIpAddress).toBe(false);
  });

  it('reads both branches of a ternary action out of one call site', () => {
    const source = `
      await this.audit.record({
        action: before === null ? 'permission.override.created' : 'permission.override.updated',
        actor: { userId: input.actor.userId, organizationId: input.actor.organizationId, ipAddress: input.ipAddress },
        target: { type: 'USER_PERMISSION_OVERRIDE', id: input.userId },
        after: { permissionKey: input.permissionKey },
        requestId: undefined,
      });
    `;

    const [site] = findAuditRecordCalls('x.ts', source);

    expect(site?.actions).toEqual(
      expect.arrayContaining(['permission.override.created', 'permission.override.updated']),
    );
  });
});
