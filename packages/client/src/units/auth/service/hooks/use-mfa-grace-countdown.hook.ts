import { useBootstrapSession } from '@units/auth/service/hooks/use-bootstrap-session.hook.js';
import { useSecondsRemaining } from '@shared/hooks';

export interface MfaGraceCountdown {
  /** The instant the grace period ends, ISO 8601 in UTC — what the sentence is built around. */
  readonly endsAt: string;
  /**
   * The moment the phrase is measured from, read **at render** rather than from the tick.
   *
   * The interval below exists to *cause* the render; if it also supplied the instant, every answer
   * would be as old as the last tick — the mistake `useSecondsRemaining` documents about its own
   * number, made one level up.
   */
  readonly now: Date;
}

/**
 * How long this session has before the organization's policy stops letting it in (acceptance 4).
 *
 * `null` for everybody the policy does not cover — which is every session of every installation
 * that has not switched a policy on. The field is **absent** rather than `false` on that answer, so
 * this branches on presence and never has to read a value as «no».
 *
 * **The clock is the one legitimate effect in this unit.** A countdown is a real side effect with an
 * external source — `rules/frontend-fsd.mdc` rule 11 keeps `useEffect` for exactly this and forbids
 * it for everything else — and it is not written here: `useSecondsRemaining` owns the interval, and
 * `useInterval` from `@mantine/hooks` clears it on unmount, which is the whole of the cleanup such
 * an effect has to get right. Ticking once a second over a deadline days away is deliberate: it
 * costs one comparison and one re-render of one banner, and it is what makes the last hour read
 * honestly instead of freezing on «in 1 day» until somebody reloads.
 *
 * The session is read through the bootstrap hook rather than from the store directly, so the banner
 * appears the moment the first `POST /auth/refresh` answers rather than one navigation later.
 */
export const useMfaGraceCountdown = (): MfaGraceCountdown | null => {
  const session = useBootstrapSession();

  const endsAt = session.status === 'authenticated' ? session.mfaGraceEndsAt : undefined;
  // Subscribes this component to a once-a-second re-render while the deadline is still ahead. The
  // number itself is not used — `RelativeTime` phrases the distance — but the tick is what keeps the
  // phrase from freezing on «in 1 day» for an hour.
  useSecondsRemaining(endsAt === undefined ? null : Date.parse(endsAt));

  if (endsAt === undefined) return null;

  return { endsAt, now: new Date() };
};
