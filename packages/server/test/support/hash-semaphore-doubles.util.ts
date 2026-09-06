import {
  createHashSemaphore,
  type HashSemaphore,
} from '@/infrastructure/crypto/argon2-semaphore.util.js';

/**
 * A ceiling whose only slot is held by a computation that never finishes, and whose wait budget is
 * zero — so every arrival is refused on its deadline, exactly as a host under a flood refuses one.
 *
 * The slot is taken synchronously: `acquire`'s fast path has nothing to await, so `inFlight` is
 * already 1 when this returns and the very next `run` queues.
 */
export const saturatedHashSemaphore = (): HashSemaphore => {
  const semaphore = createHashSemaphore({ maxConcurrency: 1, queueTimeoutMs: 0 });

  void semaphore.run(async () => new Promise<never>(() => undefined));

  return semaphore;
};

/** A ceiling nothing is contending for. */
export const idleHashSemaphore = (): HashSemaphore =>
  createHashSemaphore({ maxConcurrency: 4, queueTimeoutMs: 2_000 });

/**
 * A ceiling that admits `admitted` computations and refuses every one after them.
 *
 * The shape a mint meets in practice. `GenerateRecoveryCodesUseCase.mint()` queues **ten** hashes
 * one after another, so the interesting refusal is not "the queue was full when the request
 * arrived" — it is "the queue filled up in the middle", after some of the batch has already been
 * computed and none of it can be kept. A semaphore that refuses everything cannot express that
 * moment, and a path whose hashing sits outside the refund wrapper passes against one.
 */
export const hashSemaphoreRefusingAfter = (admitted: number): HashSemaphore => {
  const open = createHashSemaphore({ maxConcurrency: 4, queueTimeoutMs: 2_000 });
  let remaining = admitted;

  return {
    run: async <T>(work: () => Promise<T>): Promise<T> => {
      if (remaining <= 0) return await saturatedHashSemaphore().run(work);

      remaining -= 1;

      return await open.run(work);
    },
  };
};
