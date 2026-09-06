import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';

/**
 * How many argon2id computations may exist at once, and how long a request may wait for a slot.
 *
 * `onInFlightChange` is where `argon2_inflight` is fed from. A callback rather than a `MetricsPort`
 * dependency: the semaphore has no business knowing what publishes the number, and an installation
 * with `METRICS_ENABLED=false` passes nothing at all instead of a no-op adapter.
 *
 * It is an observer, never a participant: whatever it throws is dropped, and the reading with it.
 * See `publish` below for why the boundary is drawn there and not around it.
 */
export interface HashSemaphoreOptions {
  readonly maxConcurrency: number;
  readonly queueTimeoutMs: number;
  readonly onInFlightChange?: (inFlight: number) => void;
}

export interface HashSemaphore {
  /** Runs `task` once a slot is free, or refuses with 503 if the wait outlives the budget. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * A request parked in the queue: admitted when a slot is handed over, dropped when it expires.
 *
 * `timer` is assigned immediately after the object is built rather than in the initialiser, because
 * the two are circular — the timer has to be able to find this waiter in order to remove it from
 * the queue, and admitting the waiter has to cancel that timer.
 */
interface Waiter {
  readonly resolve: () => void;
  timer?: NodeJS.Timeout;
  /**
   * Set when the wait ran out. The waiter is left in the queue and skipped on the way past rather
   * than spliced out of it: searching for its own index is the operation that goes wrong quietly —
   * `indexOf` answers `-1` for anything already gone, and `splice(-1, 1)` then removes **somebody
   * else's** waiter, the last one in line.
   */
  expired?: boolean;
}

/**
 * `Retry-After` from the wait budget, and never below one.
 *
 * `Retry-After: 0` reads as "retry now", which is the tight loop the refusal exists to prevent —
 * the same reasoning, and the same floor, as `rate-limiter.adapter.ts` uses for the 429.
 */
const retryAfterSecondsOf = (queueTimeoutMs: number): number =>
  Math.max(1, Math.ceil(queueTimeoutMs / 1000));

/**
 * The ceiling on concurrent password hashing (STORY-013-06).
 *
 * ## Why a ceiling exists at all
 *
 * argon2id at the configured cost allocates `ARGON2_MEMORY_COST` KiB — 19 MiB by default — and
 * holds it for the whole computation. The rate limiter bounds attempts **per subject**, which is
 * the right shape for guessing one password and the wrong shape for this: a thousand distinct
 * addresses, each well inside its own budget, are a thousand concurrent allocations and an
 * out-of-memory kill by an attacker who never guessed anything (`docs/security/threat-model.md`,
 * T-IAM-08). The budget-per-subject half of that threat is `login.use-case.ts`; this is the other
 * half.
 *
 * ## Why the wait is bounded
 *
 * A queue with no deadline is the same exhausted memory one layer up. Each waiter still holds a
 * socket, a parsed body and a promise chain, and the browser that gave up thirty seconds ago is
 * never told — so the refusal is explicit: `503 service_unavailable` with a `Retry-After`, through
 * the one mechanism the rate limiter's 429 already uses (`error-handler.middleware.ts`).
 *
 * ## Fairness
 *
 * Strictly FIFO, and a freed slot is **handed over** rather than released and re-taken. Releasing
 * it first would let a request that arrived a millisecond ago take the slot ahead of one that has
 * been waiting for the whole budget, which under load is indistinguishable from starvation.
 */
export const createHashSemaphore = ({
  maxConcurrency,
  queueTimeoutMs,
  onInFlightChange,
}: HashSemaphoreOptions): HashSemaphore => {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError(`argon2 concurrency must be a whole number of at least 1`);
  }

  const waiting: Waiter[] = [];
  let inFlight = 0;

  /**
   * Announces `inFlight`, and cannot fail.
   *
   * The guard is on the function rather than on its call sites, because every call site publishes
   * from the middle of accounting for a slot, and the two ends fail differently. Through `acquire`
   * the increment has happened and `run` has not yet entered the `try`, so an escaping exception
   * leaves a slot counted with nobody holding it — the leak is permanent, `maxConcurrency` of them
   * refuse every sign-in until the process is restarted, and it is precisely the failure this
   * utility exists to prevent. Through `release` the decrement has already happened, so the count
   * survives, but the throw comes out of `run`'s `finally` and **replaces** what the block was
   * carrying: a completed hash turns into a 500, and a genuine failure vanishes behind the gauge's.
   * Guarding here holds for call sites that do not exist yet; guarding each caller makes it
   * something every future one has to remember.
   *
   * The reading is dropped rather than reported, because there is nowhere to report it to: taking a
   * callback instead of a `MetricsPort` is the whole point of the option, and the semaphore has no
   * logger. A gauge that missed a sample is a smaller failure than a door that admits nobody.
   */
  const publish = (): void => {
    try {
      onInFlightChange?.(inFlight);
    } catch {
      // Deliberately swallowed — see above. Metrics do not get to close the door.
    }
  };

  const acquire = async (): Promise<void> => {
    if (inFlight < maxConcurrency) {
      inFlight += 1;
      publish();

      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve };

      const timer = setTimeout(() => {
        // Marked, not removed. A slot must never be handed to a waiter nobody is waiting on — that
        // is how a ceiling leaks downwards until the process admits none — so `release` skips it.
        waiter.expired = true;

        reject(
          new ServiceUnavailableError(
            { dependency: 'password-hashing', waitedMs: queueTimeoutMs },
            undefined,
            retryAfterSecondsOf(queueTimeoutMs),
          ),
        );
      }, queueTimeoutMs);

      // The process must not be held open by a request that is only waiting for a slot.
      timer.unref();

      waiter.timer = timer;
      waiting.push(waiter);
    });
  };

  const release = (): void => {
    let next = waiting.shift();

    // Past everybody whose wait already ran out — they have been refused and are not coming back.
    while (next?.expired === true) next = waiting.shift();

    // The slot moves from one computation to the next: `inFlight` is unchanged, so nothing is
    // published, and no arrival can slip in between the two.
    if (next !== undefined) {
      clearTimeout(next.timer);
      next.resolve();

      return;
    }

    inFlight -= 1;
    publish();
  };

  return {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      await acquire();

      try {
        return await task();
      } finally {
        release();
      }
    },
  };
};
