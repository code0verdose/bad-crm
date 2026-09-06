import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SharedAudit, SharedPermissions } from '@bad-crm/shared';

import { isDegradableAuditAction } from '@/application/platform/audit/degradable-audit-actions.util.js';

/**
 * Which actions may go through without their audit row — STORY-016-02, acceptance 9.
 *
 * The line is drawn from **two** catalogues and read back from both: an action may degrade only
 * when its severity is `INFO` **and** none of the keys it stands behind is one the permission
 * catalogue marks `dangerous`. Severity alone was the first draft, and it was wrong on the day it
 * shipped: `permission.inspected` is `INFO` and is the only trace of `permission:override_read`, a
 * dangerous read — under the first draft a failed insert let that read succeed unrecorded, which is
 * the hole the entry exists to close.
 *
 * The expected set is derived here, not listed: an action added next month gets a severity and a
 * row in `AUDIT_ACTION_PERMISSIONS` (neither compiles without one), and this suite holds for it on
 * the day it is added. If that action is `INFO` and stands behind a dangerous key, the derivation
 * puts it on the fail-closed side, and the case below that names the pair by class catches a
 * function that disagrees.
 */

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);

    return entry.name.endsWith('.ts') ? [path] : [];
  });

/** Every permission key spelled as a literal somewhere a check is made: policies and the route registry. */
const checkedPermissionKeys = (): Set<string> => {
  const found = new Set<string>();

  for (const file of sourceFiles(SRC)) {
    if (!file.endsWith('.policy.ts') && !file.endsWith('route-registry.factory.ts')) continue;

    for (const [, key] of readFileSync(file, 'utf8').matchAll(/'([a-z_]+:[a-z_]+)'/g)) {
      if (key !== undefined && SharedPermissions.isPermissionKey(key)) found.add(key);
    }
  }

  return found;
};

const expectedDegradable = (action: SharedAudit.AuditAction): boolean =>
  SharedAudit.severityOf(action) === 'INFO' && !SharedAudit.isBehindDangerousPermission(action);

describe('which audit actions may degrade when their row cannot be written', () => {
  it('agrees with the set derived from severity and the dangerous flag of the key behind it', () => {
    const decisions = SharedAudit.AUDIT_ACTIONS.map((action) => ({
      action,
      severity: SharedAudit.severityOf(action),
      behindDangerous: SharedAudit.isBehindDangerousPermission(action),
      expected: expectedDegradable(action),
      actual: isDegradableAuditAction(action),
    }));

    const disagreements = decisions.filter((entry) => entry.expected !== entry.actual);
    const report = disagreements
      .map(
        (entry) =>
          `${entry.action} (${entry.severity}, dangerous key behind: ${entry.behindDangerous}) — ` +
          `expected ${entry.expected ? 'degradable' : 'fail-closed'}, got ${entry.actual ? 'degradable' : 'fail-closed'}`,
      )
      .join('\n');

    expect(disagreements, report).toEqual([]);
  });

  it('never lets a WARNING or CRITICAL action through, whatever key it stands behind', () => {
    const loud = SharedAudit.AUDIT_ACTIONS.filter(
      (action) => SharedAudit.severityOf(action) !== 'INFO',
    );

    expect(loud.filter(isDegradableAuditAction)).toEqual([]);
    expect(loud.length).toBeGreaterThan(0);
  });

  /**
   * The class of entry the first draft got wrong, asserted by class rather than by the one name that
   * exists today: every `INFO` action behind a dangerous key holds the transaction. The named
   * control below proves the class is not empty.
   */
  it('holds every INFO action that stands behind a dangerous key', () => {
    const quietButDangerous = SharedAudit.AUDIT_ACTIONS.filter(
      (action) =>
        SharedAudit.severityOf(action) === 'INFO' &&
        SharedAudit.isBehindDangerousPermission(action),
    );

    expect(quietButDangerous.filter(isDegradableAuditAction)).toEqual([]);
    // CONTROL: the class exists in the catalogue today, so the filter above did not pass over nothing.
    expect(quietButDangerous).toContain('permission.inspected');
  });

  /** CONTROL: the catalogue has both kinds, so the derivation did not pass over an empty side. */
  it('CONTROL: the catalogue holds actions on both sides of the line', () => {
    const degradable = SharedAudit.AUDIT_ACTIONS.filter(isDegradableAuditAction);

    expect(degradable.length).toBeGreaterThan(0);
    expect(degradable.length).toBeLessThan(SharedAudit.AUDIT_ACTIONS.length);
    // A quiet action behind an ordinary key is the shape that does degrade; the three membership
    // entries are it (`team:manage_members` carries no flag, even though a team can be an ACL
    // subject since 2026-09-06 — the grant is the dangerous action, and it is filed at `WARNING`).
    expect(degradable).toContain('team.member_added');
    expect(degradable).toContain('session.signed_in');
  });

  /**
   * The join is only as good as its rows. Every key the map names is one some policy or the route
   * registry actually checks — a key nobody checks would mean the row describes a use-case that does
   * not exist, and the reading above would be about nothing.
   */
  it('names only keys the source actually checks somewhere', () => {
    const checked = checkedPermissionKeys();
    const unchecked = SharedAudit.AUDIT_ACTIONS.flatMap((action) =>
      SharedAudit.permissionsBehind(action)
        .filter((key) => !checked.has(key))
        .map((key) => `${action} → ${key}`),
    );

    expect(unchecked).toEqual([]);
    // CONTROL: the scan found keys at all.
    expect(checked.size).toBeGreaterThan(10);
  });
});
