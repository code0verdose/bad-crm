import { describe, expect, it } from 'vitest';

import { DENY_REASONS, isDenyReason } from '../../src/permissions/index.js';

/**
 * The closed list of refusal reasons, held to the document that defines it.
 *
 * The reason travels into the audit trail, into the `problem+json` type URI and into the interface,
 * so a reason invented at a call site is a reason nobody translated and no filter over the trail can
 * find. The parity with `docs/security/permission-model.md` is asserted in the repository suite,
 * which may read documents; here the shape is what matters.
 */
describe('deny reasons', () => {
  it('is a non-empty, duplicate-free list', () => {
    expect(DENY_REASONS.length).toBeGreaterThan(0);
    expect(new Set(DENY_REASONS).size).toBe(DENY_REASONS.length);
  });

  it.each([...DENY_REASONS])('%s is snake_case', (reason) => {
    expect(reason).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('narrows an arbitrary string only when the list contains it', () => {
    expect(isDenyReason('denied_by_override')).toBe(true);
    expect(isDenyReason('forbidden')).toBe(false);
  });

  /**
   * The two that carry the invariants of the model rather than a mechanical outcome: a 404 for
   * another tenant's resource, and an ALLOW that a per-user DENY beats.
   */
  it('names the refusals the model insists on', () => {
    expect(DENY_REASONS).toContain('resource_not_found');
    expect(DENY_REASONS).toContain('denied_by_override');
  });
});
