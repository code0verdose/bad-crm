/**
 * Identifier factory for everything the application creates: entity ids, request ids, job ids.
 *
 * Injected for the same reason as the clock — `Math.random()` and `ulid()` called inside a use-case
 * make the result unassertable. The ULID adapter lives in `infrastructure/platform`.
 */
export interface IdGeneratorPort {
  next(): string;
}
