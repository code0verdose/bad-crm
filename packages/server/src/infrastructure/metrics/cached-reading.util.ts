/**
 * A number that is expensive to fetch, served to whoever asks and refreshed on our own schedule.
 *
 * ## The problem it exists for
 *
 * Most of what `/metrics` publishes is pushed: the process counts as it works and the scrape reads
 * memory. A size on disk is the opposite — nothing in the request path knows it, so it has to be
 * asked for. The obvious place to ask is the gauge's `collect`, and that hands the schedule of a
 * database query to **whoever is scraping**: Prometheus at 15 s, a second Prometheus at 15 s, a
 * curl loop in a cron, a dashboard refreshing on a mouse move. The database load of an installation
 * would then be a property of somebody else's configuration.
 *
 * The alternative — a timer inside the API process — is a scheduler, and this product has none: no
 * queue is wired, and inventing one for a single reading is a decision for an ADR, not for a
 * metrics adapter. So the read stays where the scrape triggers it and is rate-limited instead: at
 * most one every `maxAgeMs`, whatever the scrape interval, and none at all in an installation that
 * never scrapes.
 *
 * ## Three behaviours, each of them load-bearing
 *
 * - **Stale beats absent.** A failed refresh keeps the last reading rather than dropping the series:
 *   a gap in a gauge reads on a dashboard as «zero», and zero bytes of audit trail is a more
 *   alarming and less true statement than a number a minute old.
 * - **One flight at a time.** Two scrapes arriving together share the refresh instead of opening
 *   two connections; the second is exactly the case a busy moment produces.
 * - **It never rejects.** `collect` throwing takes the whole exposition text with it, so a database
 *   hiccup would blank every other metric on the endpoint — including the ones an operator is using
 *   to work out what is wrong.
 */
export interface CachedReadingOptions {
  readonly read: () => Promise<number>;
  /** How stale the served value may be before the next caller pays for a refresh. */
  readonly maxAgeMs: number;
  /** Injected so the expiry can be asserted without waiting for it. */
  readonly now?: () => number;
}

export interface CachedReading {
  /** The current value, or `undefined` while nothing has ever been read successfully. */
  (): Promise<number | undefined>;
}

export const cachedReading = ({
  read,
  maxAgeMs,
  now = Date.now,
}: CachedReadingOptions): CachedReading => {
  let value: number | undefined;
  let readAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  const refresh = async (): Promise<void> => {
    try {
      const fresh = await read();

      value = fresh;
      readAt = now();
    } catch {
      // Deliberately swallowed, and deliberately without touching `readAt`: a failure must not
      // become a cached one, so the next caller tries again instead of waiting out the window.
    } finally {
      inFlight = undefined;
    }
  };

  return async (): Promise<number | undefined> => {
    if (now() - readAt < maxAgeMs) {
      return value;
    }

    inFlight ??= refresh();

    await inFlight;

    return value;
  };
};
