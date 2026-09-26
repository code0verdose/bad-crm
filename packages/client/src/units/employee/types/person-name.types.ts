/**
 * The two fields a person's name is made of, and no more.
 *
 * Structural rather than taken from `api` (`lib` may not import `api`,
 * `test/architecture/layers.test.ts`): a directory row, an org-chart node and the project's own
 * lookup rows all carry these two, and each satisfies this at its call site without a mapping.
 */
export interface PersonNameParts {
  readonly firstName: string;
  readonly lastName: string;
}
