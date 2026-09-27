/**
 * How far the calendar has moved between a project's start and its deadline.
 *
 * A statement about dates and nothing else: how much of the *work* is done is the tasks' answer,
 * and tasks arrive in M3. Named «progress by dates» on the screen for that reason
 * (STORY-014-05, acceptance 4).
 */
export interface DateProgress {
  /** Whole percent of the span already behind, `0…100`. */
  readonly percent: number;
  /** The deadline has passed — strictly: the instant of the deadline itself is still on time. */
  readonly isOverdue: boolean;
}

/**
 * The fields a person's label is built from — structural, so `lib` does not name the contract
 * (`rules/frontend-fsd.mdc` rule 4: `lib` does not import `api`). The directory's own rows satisfy
 * it at the call site, which is where a drift would show.
 */
export interface PersonName {
  readonly userId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
}

/**
 * A project as a write carries it — structural, for the same reason `PersonName` is: `lib` does not
 * import `api`. The contract's `ProjectPatch` satisfies it at the call site, which is where a drift
 * would show. `description` and both dates are required-and-nullable rather than optional: `PATCH`
 * replaces the project as a whole, and «not set» has to be said, not left out.
 */
export interface ProjectPatchValues {
  readonly name: string;
  readonly description: string | null;
  readonly leadId: string;
  readonly color: string;
  readonly startedAt: string | null;
  readonly dueAt: string | null;
}

/** The create body: the patch plus the two fields that are chosen once. */
export interface ProjectDraftValues extends ProjectPatchValues {
  readonly key: string;
  readonly visibility: 'PUBLIC_ORG' | 'PRIVATE';
}

/** The fields of a stored project the settings form starts from. */
export type ProjectEditSource = ProjectPatchValues;
