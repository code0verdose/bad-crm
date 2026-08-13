import { describe, expect, it } from 'vitest';

import { invitationRows } from '@widgets/invitation-list/lib/invitation-rows.util.js';

/**
 * The join between an invitation and the two conditional reads that can name its role and inviter.
 *
 * Covered here rather than through the widget because the branch that mattered is invisible from
 * there: a person whose profile carries no name at all. The screen renders whatever this returns,
 * so a widget test asserting «the inviter column shows something» passes on both sides of the
 * branch — the same shape of blindness `cimode` produces for a forgotten `t()`.
 */

const PERSON_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';
const INVITATION_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';

const person = (firstName: string, lastName: string) =>
  ({
    userId: PERSON_ID,
    email: 'ada@example.test',
    firstName,
    lastName,
    status: 'ACTIVE',
  }) as unknown as Parameters<typeof invitationRows>[2][number];

const invitation = () =>
  ({
    invitation: {
      id: INVITATION_ID,
      email: 'newcomer@example.test',
      roleId: null,
      teamIds: [],
      invitedById: PERSON_ID,
      createdAt: '2026-08-13T10:00:00.000Z',
      expiresAt: '2026-08-20T10:00:00.000Z',
    },
    isExpired: false,
  }) as unknown as Parameters<typeof invitationRows>[0][number];

describe('naming the person who invited', () => {
  it('uses the full name when there is one', () => {
    const [row] = invitationRows([invitation()], [], [person('Ada', 'Lovelace')]);

    expect(row?.invitedByLabel).toBe('Ada Lovelace');
  });

  /**
   * The branch this file exists for. A profile with both name fields empty is ordinary — an account
   * created by invitation and never filled in — and the address is the only thing left to show.
   * Falling through to an empty string would render a blank cell that reads as «nobody invited
   * this», which is a different and untrue statement.
   */
  it('falls back to the address when the profile carries no name', () => {
    const [row] = invitationRows([invitation()], [], [person('', '')]);

    expect(row?.invitedByLabel).toBe('ada@example.test');
  });

  it('leaves the label absent when the inviter is not among the people that could be read', () => {
    const [row] = invitationRows([invitation()], [], []);

    expect(row?.invitedByLabel).toBeUndefined();
  });
});
