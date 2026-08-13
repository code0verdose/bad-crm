/**
 * Whether an invitation has run out, decided **here** rather than read off the answer.
 *
 * `GET /invitations` carries `expiresAt` and no `expired` flag, and the contract says why in the
 * schema itself: a boolean computed by the server is stale by the time the screen renders it — a
 * list fetched at 09:59 would keep calling a dead link live for as long as the tab stays open.
 *
 * The boundary is the server's own. The conditional `UPDATE` that spends an invitation matches
 * `expires_at > $now` (`prisma/migrations/20260807150000_team_members_and_invitation_resolver`), so
 * the instant of expiry is already refused — `<=`, not `<`.
 *
 * `now` is a parameter rather than `new Date()` inside, so the comparison is a pure function of its
 * inputs: a screen that read the clock in here could only be tested by moving the machine's.
 */
export const isInvitationExpired = (expiresAt: string, now: Date): boolean =>
  new Date(expiresAt).getTime() <= now.getTime();
