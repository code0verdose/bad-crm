/**
 * The shapes `lib/` works against — structural, and deliberately not the contract's own types.
 *
 * The call chain forbids `lib` from importing `api` (`rules/frontend-fsd.mdc` rule 4, enforced by
 * `test/architecture/layers.test.ts`), and the reason is worth restating rather than worked around:
 * a pure function that names a generated type is a pure function that cannot be reasoned about
 * without the generator. So the utilities are written against the fields they actually read.
 *
 * **Nothing here drifts silently**, and not because it is watched: the functions are generic over
 * these shapes and are called with the contract's types, so a `TeamListEntry` that stopped carrying
 * `memberCount` — or a `TeamDraft` that gained a required field — fails to satisfy the constraint at
 * the call site. The proof is the compiler at the place the two meet, which is exactly where a
 * mismatch would matter.
 */

/** What ordering and searching a team list actually reads. */
export interface TeamRow {
  readonly name: string;
  readonly slug: string;
  readonly memberCount: number;
}

/**
 * A team as a write carries it.
 *
 * `description` is required and nullable here while the contract makes it optional: «not written» is
 * a decision this form always makes, and leaving the key out would be leaving `PATCH` — which
 * replaces rather than merges — to guess.
 */
export interface TeamDraftValues {
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
}
