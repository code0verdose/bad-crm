/**
 * How a password becomes a stored digest, and how a stored digest answers a login.
 *
 * The port is deliberately small and deliberately *not* called "argon2 something": the algorithm is
 * an infrastructure decision (`@node-rs/argon2`, CLAUDE.md → «Что шифруется»), and a use-case that
 * knew it could not be unit-tested without the native binding.
 */
export interface PasswordHasherPort {
  hash(password: string): Promise<string>;

  /**
   * Whether `password` produced `digest`. Never throws: an unreadable digest is `false`.
   *
   * A throw here would be observable. On the sign-in path it becomes a 500 while a wrong password
   * is a 401, which separates "this row has a broken hash" from "wrong password" for anybody
   * watching the responses — a smaller oracle than user enumeration, and the same kind.
   */
  verify(digest: string, password: string): Promise<boolean>;

  /**
   * Whether `digest` was produced with weaker parameters than the ones in force.
   *
   * The mechanism behind the epic's acceptance criterion "old hashes keep verifying and are
   * transparently re-hashed": raising the cost must not lock anybody out, so the upgrade happens on
   * the next successful sign-in, where the plaintext is in hand for exactly one moment.
   */
  needsRehash(digest: string): boolean;

  /**
   * A digest no password matches, at the cost currently in force.
   *
   * It exists so that a login for an address nobody has costs the same as a login with a wrong
   * password. Skipping the verification when there is no user is the difference between a few
   * microseconds and a hundred milliseconds — a difference a script measures far more reliably than
   * it reads a response body (EPIC-006 acceptance; `docs/security/rls-design.md`, «Путь 1»).
   */
  readonly dummyHash: string;
}
