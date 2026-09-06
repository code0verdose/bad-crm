import { describe, expect, it } from 'vitest';

import { policyRoleLabelKey, policyRoleOptions } from './policy-role-label.util.js';

/**
 * A role reference is two things wearing one type: a system role key from a closed catalogue, and a
 * name an organization invented for a role of its own. Only the first has a translation, and the
 * difference has to be decided somewhere that can be shown to work — a fallback written inside
 * `t()` would print the invented name *through* the catalogue and make the pseudo-locale gate call
 * it translated.
 */

const shout = (key: string): string => `[${key}]`;

describe('policyRoleLabelKey', () => {
  it('names the sentence of a system role', () => {
    expect(policyRoleLabelKey('admin')).toBe('organization.security.role.admin');
  });

  it('has nothing to say about a role the organization invented', () => {
    expect(policyRoleLabelKey('security-officer')).toBeUndefined();
  });

  /**
   * `Object.hasOwn`, not `in`: `'toString' in POLICY_ROLE_LABEL` is `true` through the prototype,
   * and a role somebody called `constructor` would otherwise be «translated» into a function.
   */
  it('is not fooled by an inherited property name', () => {
    expect(policyRoleLabelKey('constructor')).toBeUndefined();
  });
});

describe('policyRoleOptions', () => {
  it('translates what it can and shows the rest as the organization spelled it', () => {
    expect(policyRoleOptions(['admin', 'security-officer'], shout)).toEqual([
      { value: 'admin', label: '[organization.security.role.admin]' },
      { value: 'security-officer', label: 'security-officer' },
    ]);
  });
});
