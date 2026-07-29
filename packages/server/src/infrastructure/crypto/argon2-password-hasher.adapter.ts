import { randomBytes } from 'node:crypto';
import { hash, hashSync, verify, type Algorithm, type Version } from '@node-rs/argon2';

import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';

/**
 * argon2id through `@node-rs/argon2`, with the parameters an operator may raise and may not lower.
 *
 * `Version.V0x13` and `Algorithm.Argon2id` are stated rather than defaulted: the two other
 * algorithms of the family are argon2i (side-channel resistant, weak against GPUs) and argon2d (the
 * reverse), and the recommendation this project follows is the hybrid. A default is a decision
 * somebody else gets to change in a minor release.
 */
export interface Argon2Parameters {
  /** KiB of memory per hash. */
  readonly memoryCost: number;
  /** Passes over that memory. */
  readonly timeCost: number;
  /** Lanes. */
  readonly parallelism: number;
}

/**
 * The floor, from the OWASP Password Storage Cheat Sheet: argon2id with 19 MiB of memory, two
 * iterations and one degree of parallelism.
 *
 * A floor and not a default. The default lives in `env.schema.ts`, where an operator can raise it;
 * this is the value below which the adapter refuses to run at all. Without the refusal, halving
 * `ARGON2_MEMORY_COST` to fit a small container is a one-line change that produces digests
 * indistinguishable from the strong ones and is discovered by nobody — the parameters are recorded
 * *inside* each digest, so the weakening is silent and permanent for every password set afterwards.
 */
export const ARGON2_MINIMUM: Argon2Parameters = Object.freeze({
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

/**
 * `Algorithm.Argon2id` and `Version.V0x13` of `@node-rs/argon2`, as values rather than as members.
 *
 * The library declares both as `const enum`, which `verbatimModuleSyntax` cannot import as a value —
 * a const enum is erased at compile time and has no runtime object to read. The numbers are part of
 * the argon2 format itself and are visible in every digest this produces (`$argon2id$v=19$…`), so
 * they are stated here with the assertion that names what they are, and the tests read them back out
 * of the digest rather than trusting this line.
 */
const ARGON2ID = 2 as Algorithm;
const ARGON2_VERSION_0X13 = 1 as Version;

/** `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>` — the three cost fields, as stored. */
const COST_FIELDS = /\$m=(\d+),t=(\d+),p=(\d+)\$/;

const belowFloor = (parameters: Argon2Parameters): keyof Argon2Parameters | undefined => {
  if (parameters.memoryCost < ARGON2_MINIMUM.memoryCost) return 'memoryCost';
  if (parameters.timeCost < ARGON2_MINIMUM.timeCost) return 'timeCost';

  return parameters.parallelism < ARGON2_MINIMUM.parallelism ? 'parallelism' : undefined;
};

export class Argon2PasswordHasher implements PasswordHasherPort {
  readonly dummyHash: string;

  private readonly options: {
    algorithm: Algorithm;
    version: Version;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };

  constructor(private readonly parameters: Argon2Parameters) {
    const weak = belowFloor(parameters);

    if (weak !== undefined) {
      throw new RangeError(
        `argon2id ${weak} is below the OWASP floor (${ARGON2_MINIMUM[weak]}); raise it or leave the default`,
      );
    }

    this.options = {
      algorithm: ARGON2ID,
      version: ARGON2_VERSION_0X13,
      memoryCost: parameters.memoryCost,
      timeCost: parameters.timeCost,
      parallelism: parameters.parallelism,
    };

    // Hashed once, at construction, over bytes nobody holds: the value has to be a real digest at
    // the real cost — a constant string would make the "no such user" branch finish in nanoseconds
    // and restore the timing oracle it exists to remove. Synchronous on purpose: this runs at
    // start-up, before the listener, and an async constructor would make every consumer await it.
    this.dummyHash = hashSync(randomBytes(32), this.options);
  }

  /**
   * Asynchronous, unlike the one call above. `hashSync` runs Argon2id on the main thread, and at
   * m=19456 that is 30–60 ms during which the process answers nothing at all — not `/health`, not
   * another tenant's request. It is reached from `POST /auth/register`, which is public, so one
   * client in a loop is enough to hold the event loop at a hundred percent; the same call also sits
   * inside the open transaction of the transparent re-hash on sign-in. The library runs the async
   * form on the libuv threadpool, where the cost belongs.
   */
  async hash(password: string): Promise<string> {
    return await hash(password, this.options);
  }

  async verify(digest: string, password: string): Promise<boolean> {
    try {
      return await verify(digest, password, this.options);
    } catch {
      // Not a digest at all. `false`, never a throw — see the port's comment on why the distinction
      // must not be observable from outside.
      return false;
    }
  }

  /**
   * `true` when the digest is weaker than the configuration in force, or unreadable.
   *
   * Unreadable counts as "replace": the row cannot verify anything, and the next successful sign-in
   * (which by then went through some other path) is the moment to write a digest that can.
   *
   * A *stronger* digest is left alone. Rehashing it would quietly weaken the credential of everybody
   * who signed in after an operator rolled a parameter back — the opposite of what this exists for.
   */
  needsRehash(digest: string): boolean {
    const fields = COST_FIELDS.exec(digest);

    if (fields === null || !digest.startsWith('$argon2id$')) return true;

    const [, memory = '0', time = '0', lanes = '0'] = fields;

    return (
      Number(memory) < this.parameters.memoryCost ||
      Number(time) < this.parameters.timeCost ||
      Number(lanes) < this.parameters.parallelism
    );
  }
}
