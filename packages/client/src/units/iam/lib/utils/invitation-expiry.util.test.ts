import { describe, expect, it } from 'vitest';

import { isInvitationExpired } from './invitation-expiry.util.js';

/**
 * «Просрочено» is a comparison with the clock, and the boundary is the whole of it.
 *
 * The contract says so in as many words (`Invitation.expiresAt`: «a date rather than an `expired`
 * flag»), and the server's own predicate is `expires_at > $now` — the conditional `UPDATE` that
 * spends an invitation, `prisma/migrations/20260807150000_team_members_and_invitation_resolver`.
 * So the instant itself is **past**, not still valid, and a client that rounded the other way would
 * offer a link the server has already stopped accepting.
 */

const EXPIRES = '2026-08-13T10:00:00.000Z';

describe('whether an invitation has run out', () => {
  it.each([
    ['a minute before it runs out', '2026-08-13T09:59:00.000Z', false],
    ['a minute after', '2026-08-13T10:01:00.000Z', true],
    // The boundary the server draws: `expires_at > now` accepts, so equality is already refused.
    ['at the exact instant it runs out', EXPIRES, true],
    ['a millisecond before that instant', '2026-08-13T09:59:59.999Z', false],
  ])('%s', (_case, now, expected) => {
    expect(isInvitationExpired(EXPIRES, new Date(now))).toBe(expected);
  });
});
