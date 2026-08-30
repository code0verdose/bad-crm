import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type HashSemaphore } from '@/infrastructure/crypto/argon2-semaphore.util.js';

/**
 * Any password hasher, with a ceiling on how many of its computations may run at once.
 *
 * ## Why it decorates the port instead of living in a use-case
 *
 * Two properties follow from wrapping `PasswordHasherPort` rather than calling a semaphore from
 * `LoginUseCase`, and both are the point:
 *
 * 1. **Every argon2id computation in the process is inside the ceiling** — sign-in, registration,
 *    the password change, the reset, the ten verifications a recovery code costs. A ceiling wired
 *    at one call site bounds one endpoint and leaves the rest of the memory unbounded.
 * 2. **The place in the queue is taken before the account is known to exist.** `LoginUseCase`
 *    verifies a dummy digest when the address matches nobody, so that branch costs what a real one
 *    costs; because the ceiling is *inside* the port, the dummy verification queues exactly like a
 *    real one. Put the ceiling in the branch where a candidate was found instead and an unknown
 *    address would sail past a saturated queue while a known one waited — an enumeration oracle
 *    louder than the timing difference the dummy digest was built to remove (STORY-013-06,
 *    acceptance 3; STORY-013-03, acceptance 8).
 *
 * `needsRehash` and `dummyHash` are pass-throughs: neither computes anything. `dummyHash` is a
 * value the wrapped hasher produced once at construction, and re-exposing it is what keeps the
 * equalising branch of the sign-in able to reach it through the decorator.
 */
export class LimitedPasswordHasher implements PasswordHasherPort {
  readonly dummyHash: string;

  constructor(
    private readonly inner: PasswordHasherPort,
    private readonly semaphore: HashSemaphore,
  ) {
    this.dummyHash = inner.dummyHash;
  }

  async hash(password: string): Promise<string> {
    return await this.semaphore.run(async () => this.inner.hash(password));
  }

  async verify(digest: string, password: string): Promise<boolean> {
    return await this.semaphore.run(async () => this.inner.verify(digest, password));
  }

  needsRehash(digest: string): boolean {
    return this.inner.needsRehash(digest);
  }
}
