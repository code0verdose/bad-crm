import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_ACTIONS_WITH_SEVERITY,
  AUDIT_RESOURCE_TYPES,
  AUDIT_SEVERITIES,
  isAuditAction,
  isAuditResourceType,
  severityOf,
} from '../../src/audit/index.js';

/**
 * The vocabulary of the trail: what happened, to what, and how loudly it reads.
 *
 * All three lists are closed for one reason — they are what a reader **filters by**. A second
 * spelling of the same thing (`user` beside `USER`, `role.assign` beside `role.assigned`) does not
 * break anything visibly: it makes a filter return half the history, which is indistinguishable from
 * «nothing happened» exactly when somebody is looking for what happened.
 */

describe('the resource vocabulary', () => {
  it.each([...AUDIT_RESOURCE_TYPES])('recognises %s', (type) => {
    expect(isAuditResourceType(type)).toBe(true);
  });

  it('refuses a spelling that is not in the list', () => {
    // The lower-case forms the code used before the list existed. They are the failure this list
    // prevents, so they are named here rather than described.
    expect(isAuditResourceType('user')).toBe(false);
    expect(isAuditResourceType('session-family')).toBe(false);
  });

  it('has no duplicates', () => {
    expect(new Set(AUDIT_RESOURCE_TYPES).size).toBe(AUDIT_RESOURCE_TYPES.length);
  });
});

describe('the action vocabulary', () => {
  it.each([...AUDIT_ACTIONS])('recognises %s and gives it a severity', (action) => {
    expect(isAuditAction(action)).toBe(true);
    expect(AUDIT_SEVERITIES).toContain(severityOf(action));
  });

  it('refuses an action nobody declared', () => {
    expect(isAuditAction('role.assign')).toBe(false);
  });

  /**
   * The pairs, as a runtime list for a reader that has neither the type nor the map — an admin
   * screen listing what the trail can contain, and this assertion that the two lists cannot drift.
   */
  it('pairs every action with its severity, and nothing else', () => {
    expect(AUDIT_ACTIONS_WITH_SEVERITY.map(([action]) => action)).toEqual([...AUDIT_ACTIONS]);
  });

  it('keeps the loudest level for the one action that has no innocent cause', () => {
    // Row-level security bypassed on purpose: nothing in normal operation raises it, and an untraced
    // bypass is indistinguishable from an intrusion.
    expect(severityOf('rls.bypassed')).toBe('CRITICAL');
  });
});
