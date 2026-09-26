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
