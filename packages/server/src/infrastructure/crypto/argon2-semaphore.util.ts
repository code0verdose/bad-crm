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
  /**
   * Where `argon2_queued` is fed from, and the reason the pair of gauges is two numbers and not one.
   *
   * `argon2_inflight` answers "is the ceiling reached", and by construction it stops moving there:
   * four of four looks identical whether one request is waiting behind it or five hundred are. The
   * depth is the number that separates a busy minute from a flood, and the one that says how close
   * an installation is to shedding load it could otherwise have served.
   */
  readonly onQueuedChange?: (queued: number) => void;
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
 * The shortest one argon2id computation can take at parameters this process will accept.
 *
 * **Measured, not assumed** — 14.4 ms mean, 14.2 p50, 16.7 p95 over twenty verifications
 * (`@node-rs/argon2` 2.0.2, Node 22, Apple M-series, `m=19456, t=2, p=1`), rounded up to 15. The
 * hosting runbook's 50–80 ms is the same computation on the server CPUs it sizes; the *fast* end is
 * what belongs here, because this number divides a capacity — using a slow host's cost on a fast one
 * would refuse requests that host could still have served, and that is an availability bug written
 * into a defence.
 *
 * It is a floor rather than an estimate because `Argon2PasswordHasher` refuses to start below the
 * OWASP parameters (`ARGON2_MINIMUM`), so no configuration can make a computation cheaper than this
 * — only faster silicon can, and then the queue admits fewer waiters than the host could drain,
 * which errs towards refusing early rather than towards holding memory. Re-measure it if a host ever
 * reports below 15 ms; nothing else in this file has to change.
 */
const FASTEST_HASH_MS = 15;

/**
 * How many waiters may be parked at once — derived from the two knobs an operator already sets,
 * deliberately not a third one.
 *
 * `maxConcurrency / FASTEST_HASH_MS` computations complete per millisecond, so
 * `maxConcurrency × queueTimeoutMs / FASTEST_HASH_MS` is everything that can still reach a slot
 * before its own deadline fires. A waiter past that position is not queued but doomed: it will hold
 * a socket, a parsed body and a promise chain for the whole budget in order to be told 503 at the
 * end of it. Refusing it now costs it nothing it was going to get and gives the host back the
 * memory — at the defaults (4 slots, 2 000 ms) the bound is 534 waiters, against a measured ~27 KB
 * of resident memory per parked request, so ~14 MB, next to the 76 MiB the ceiling itself allows.
 *
 * The bound tracks what can be *served*, not what fits in memory, and at the far corner of both
 * ranges the two part company: 64 slots and a 60 s budget derive 256 000 waiters, which is ~6.9 GB
 * of parked requests and more sockets than any default `ulimit -n` admits — the file-descriptor
 * limit and the OS accept queue bind long before this one does. That corner is already outside what
 * the env docstrings say this product is sized for (`AUTH_ARGON2_MAX_CONCURRENCY` alone is 1.19 GiB
 * of argon2 there), so it is left described rather than clamped: a second, memory-derived ceiling
 * would be a number nobody could tie to a symptom, silently binding in configurations where the
 * derivation above is the honest answer.
 *
 * A third environment variable was the alternative and is worse in both directions: it would be one
 * more number an operator has to keep consistent with the other two — raising the wait budget
 * without raising the cap silently makes the cap the binding constraint — and it would be the
 * setting that lets an installation switch this bound off by writing a large number, which is
 * exactly the unbounded queue the derivation exists to remove.
 */
const queueCapacityOf = (maxConcurrency: number, queueTimeoutMs: number): number =>
  Math.max(1, Math.ceil((maxConcurrency * queueTimeoutMs) / FASTEST_HASH_MS));

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
 * ## Why the queue has a length as well as a deadline
 *
 * See `queueCapacityOf`. In short: a waiter past `maxConcurrency × queueTimeoutMs / cost` cannot
 * reach a slot before its own deadline fires, so parking it buys it nothing and costs the host a
 * held socket for the whole budget.
 *
 * ## Fairness
 *
 * Strictly FIFO, and a freed slot is **handed over** rather than released and re-taken. Releasing
 * it first would let a request that arrived a millisecond ago take the slot ahead of one that has
 * been waiting for the whole budget, which under load is indistinguishable from starvation.
 *
 * ## A slot is taken per computation, not per request — measured, and kept
 *
 * One recovery-code attempt costs `RECOVERY_CODE_COUNT` verifications (`RecoveryCodeMatcher`), and
 * each of them queues separately. The obvious repair is to admit such a request once and let it hold
 * its slot for all ten: one wait instead of ten, and a total wait bounded by one budget rather than
 * by ten of them. It was measured against what it costs, and **it was refused**.
 *
 * Both granularities, real `Argon2PasswordHasher` (m=19456, t=2, p=1; 14.4 ms a computation on the
 * measuring host), ceiling 4, budget 2 000 ms, 100 sign-ins arriving over a second alongside N
 * concurrent recovery attempts:
 *
 * | N | per computation (today) | per request |
 * |---|---|---|
 * | 8 | sign-in p50 92 ms, p95 109 | p50 236, p95 453 |
 * | 16 | p50 200, p95 218 | p50 708, p95 929 |
 * | 32 | p50 352, p95 383 | p50 1 649, p95 1 866 |
 *
 * Throughput is identical — the same computations happen either way — so the only thing the change
 * moves is who waits. Holding one slot for ten computations is head-of-line blocking: on the
 * measuring host a 144 ms job (10 × 14.4 ms; 0.5–0.8 s on the server CPUs `docs/runbooks/hosting.md`
 * sizes at 50–80 ms a computation) occupies a quarter of the ceiling while a one-computation sign-in
 * queues behind it. At 32 attempts that puts the sign-in's p95 at 1 866 ms — inside a 2 000 ms
 * budget by 134 ms, which is to say the next increment of load turns sign-ins into 503s. The
 * per-computation queue interleaves instead, and its worst measured sign-in p95 over the whole sweep
 * is 383 ms with zero refusals.
 *
 * What the refused change would have bought is real and goes the other way: the recovery attempt's
 * own latency (p50 2 388 → 1 151 ms at N=32) and a total wait bounded by one budget rather than ten.
 * The trade is deliberate — an attempt that is *already* holding a second factor waits longer so
 * that everybody's sign-in does not.
 *
 * **Revisit it if** the queue cap starts refusing recovery attempts mid-batch in production (they
 * spend slots and are then thrown away, the one waste this shape has), if `RECOVERY_CODE_COUNT`
 * grows, or if a measurement on server CPUs contradicts the ratios above. A per-request *deadline*
 * — one budget shared across the ten acquisitions, without holding the slot between them — is the
 * middle option this file cannot take on its own: nothing here knows where a request begins.
 */
export const createHashSemaphore = ({
  maxConcurrency,
  queueTimeoutMs,
  onInFlightChange,
  onQueuedChange,
}: HashSemaphoreOptions): HashSemaphore => {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError(`argon2 concurrency must be a whole number of at least 1`);
  }

  // The budget is validated too, and only since it started dividing a capacity. `NaN` used to cost
  // a wait that `setTimeout` collapses to 1 ms; it now also makes `queueCapacity` `NaN`, and
  // `queued >= NaN` is forever `false` — the length bound switched off with nothing to show for it.
  // Zero is still admitted on purpose: it is a degenerate but coherent configuration ("never wait"),
  // and it is what exercises the floor under `Retry-After`.
  if (!Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 0) {
    throw new RangeError(`argon2 queue timeout must be a whole number of milliseconds, or zero`);
  }

  const waiting: Waiter[] = [];
  const queueCapacity = queueCapacityOf(maxConcurrency, queueTimeoutMs);

  let inFlight = 0;
  /**
   * Live waiters — not `waiting.length`.
   *
   * The array keeps waiters whose deadline fired (they are marked and skipped rather than spliced
   * out, for the reason `Waiter.expired` gives), so its length counts requests that have already
   * been refused and gone. Capping on it would let a queue that emptied itself stay "full", which
   * is the ceiling leaking downwards in the other dimension: the process refuses arrivals it has
   * room for, and keeps refusing them until something unrelated shifts the array.
   */
  let queued = 0;

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

  /** The depth gauge, guarded for the same reason and at the same boundary as the one above. */
  const publishQueued = (): void => {
    try {
      onQueuedChange?.(queued);
    } catch {
      // Deliberately swallowed — see `publish`.
    }
  };

  const acquire = async (): Promise<void> => {
    if (inFlight < maxConcurrency) {
      inFlight += 1;
      publish();

      return;
    }

    if (queued >= queueCapacity) {
      // Refused before anything is parked, and the details say so. Both refusals are the same 503
      // to the client — nothing it could act on differs — and they are different lines in the log:
      // `wait_expired` says the host is slower than the traffic and answers a case for capacity,
      // `queue_full` says arrivals outran anything that budget could ever drain and answers a case
      // for looking at where they come from. One shared code with no discriminator would make the
      // two indistinguishable at exactly the moment an operator needs to tell them apart.
      throw new ServiceUnavailableError(
        {
          dependency: 'password-hashing',
          refusal: 'queue_full',
          // Equal to `queued` by construction at this point, so only one of the two is written.
          queueCapacity,
        },
        undefined,
        retryAfterSecondsOf(queueTimeoutMs),
      );
    }

    // Everyone at the head whose budget already ran out, dropped before another waiter is pushed on
    // top of them. `release` is the other place this happens, and on its own it is not enough: if
    // every running computation hangs — a wedged thread pool, a host in swap — `release` is never
    // called, `queued` still falls to zero on the deadlines, and arrivals park again on top of an
    // array nobody is emptying. The bound is on live waiters; this keeps the array that holds them
    // from being the leak instead. Deadlines are equal for all, so the expired are always a prefix.
    while (waiting[0]?.expired === true) waiting.shift();

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve };

      const timer = setTimeout(() => {
        // Marked, not removed. A slot must never be handed to a waiter nobody is waiting on — that
        // is how a ceiling leaks downwards until the process admits none — so `release` skips it.
        waiter.expired = true;
        queued -= 1;
        publishQueued();

        reject(
          new ServiceUnavailableError(
            { dependency: 'password-hashing', refusal: 'wait_expired', waitedMs: queueTimeoutMs },
            undefined,
            retryAfterSecondsOf(queueTimeoutMs),
          ),
        );
      }, queueTimeoutMs);

      // The process must not be held open by a request that is only waiting for a slot.
      timer.unref();

      waiter.timer = timer;
      waiting.push(waiter);
      queued += 1;
      publishQueued();
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
      queued -= 1;
      publishQueued();
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
