/**
 * Identifier factory for everything the application creates: entity ids, request ids, job ids.
 *
 * Injected for the same reason as the clock — `Math.random()` and `ulid()` called inside a use-case
 * make the result unassertable. The ULID adapter lives in `infrastructure/platform`.
 */
export interface IdGeneratorPort {
  /**
   * A sortable, human-copyable identifier for things that are *not* database rows: request ids,
   * job ids, correlation ids. ULID in the adapter.
   */
  next(): string;

  /**
   * A UUID, for the primary key of an entity.
   *
   * A separate method rather than a second adapter, and separate from `next()` on purpose: every id
   * column in `docs/architecture/data-model.md` is `uuid`, so a ULID handed to one is rejected by
   * PostgreSQL — `22P02 invalid input syntax for type uuid` — at the far end of a transaction that
   * has already written other rows. The distinction is visible at the call site instead.
   *
   * It exists because one row cannot let the database generate its own key: the tenant root is
   * created inside a scope that already names it, so the application has to know the id *before*
   * the insert (docs/security/rls-design.md, «Особый случай: organizations»).
   */
  uuid(): string;
}
