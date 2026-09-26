/**
 * The two fields a person's name is made of, and no more.
 *
 * Structural rather than a generated wire type: `shared` does not name a domain's contract. A
 * directory row, an org-chart node and the project's own lookup rows all carry these two and satisfy
 * this at the call site without a mapping.
 */
export interface PersonNameParts {
  readonly firstName: string;
  readonly lastName: string;
}
