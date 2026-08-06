/**
 * @vitest-environment node
 *
 * Every action the catalogue names is actually recorded somewhere.
 *
 * This is the gate the port exists for. A trail is only worth reading if it is complete, and the two
 * ways it stops being complete are both silent: an action added to the catalogue that nobody ever
 * records, and a call site deleted in a refactor while the name stays. Neither breaks a test that
 * exercises one scenario, because each such test only knows about its own.
 *
 * Read from the source rather than by running every scenario: the assertion is about the code
 * *having* the call, which is what survives a refactor. Running them would also pass while a sixth
 * privileged action nobody wired sat in the catalogue unnoticed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SharedAudit } from '@bad-crm/shared';

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

/**
 * `rls.bypassed` has no call site, and that is the honest state rather than a gap.
 *
 * Nothing in this codebase bypasses row level security: `guardedClient` refuses a query outside a
 * tenant scope instead of stepping around it. The name is reserved for the epic that introduces a
 * path which does — a support tool, a cross-tenant job — so that the trail is ready before the
 * capability exists rather than after.
 */
const RESERVED_WITHOUT_CALLER = new Set(['rls.bypassed']);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);

    return entry.name.endsWith('.ts') ? [path] : [];
  });

/**
 * Every action named on an `action:` line — the whole line, not just a bare literal after the colon.
 *
 * Widened when the first use-case chose between two actions with a ternary («created» or «updated»,
 * depending on whether an exception already existed): the previous pattern read only
 * `action: '…'` and silently saw neither. Reading to the end of the line keeps both directions
 * honest — a catalogue entry nobody writes still fails, and a name invented at a call site still
 * fails — without turning «write it as one literal» into a rule nobody agreed to.
 */
const recordedActions = (): Set<string> => {
  const found = new Set<string>();

  for (const file of sourceFiles(SRC)) {
    for (const [, line] of readFileSync(file, 'utf8').matchAll(/action:([^\n]*)/g)) {
      for (const [, action] of (line ?? '').matchAll(/'([a-z_.]+)'/g)) {
        if (action !== undefined) found.add(action);
      }
    }
  }

  return found;
};

describe('the audit trail covers the privileged actions of M1', () => {
  const recorded = recordedActions();
  const expected = SharedAudit.AUDIT_ACTIONS.filter(
    (action) => !RESERVED_WITHOUT_CALLER.has(action),
  );

  it.each(expected)('%s is recorded somewhere in the source', (action) => {
    expect([...recorded]).toContain(action);
  });

  /**
   * The other direction: a name recorded at a call site that the catalogue does not know is a typo
   * or a second name for an event that already has one — and a filter over the trail would then miss
   * half of it.
   */
  it('records nothing the catalogue has not named', () => {
    const stray = [...recorded].filter(
      (action) => action.includes('.') && !SharedAudit.isAuditAction(action),
    );

    expect(stray).toEqual([]);
  });

  /**
   * CONTROL: the scan has to find call sites at all. Without this the case above passes on an empty
   * set — a directory renamed, a regex that stopped matching — and the gate reports «complete» for a
   * trail with nothing in it.
   */
  it('CONTROL: found call sites to check', () => {
    expect(recorded.size).toBeGreaterThanOrEqual(expected.length);
  });
});
