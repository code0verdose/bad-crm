/**
 * What filling the personnel form needs of a record, and no more.
 *
 * Declared here rather than taken from `api`, for the reason `org-chart.types.ts` gives about the
 * tree builder and which holds identically here: `lib` may not import `api`
 * (`test/architecture/layers.test.ts`), and the narrower interface is the honest statement of what
 * the function reads. The generated wire type satisfies it structurally, so nothing is duplicated —
 * and a field added to the contract that this form does not draw cannot silently become this
 * function's business.
 *
 * **The employment keys are optional here because they are optional on the wire**, and their absence
 * means «this caller was not shown it» rather than «the person has not filled it in». Which of the
 * two it is cannot be decided from the value, only from whether the key arrived — so the caller that
 * holds the document decides, and this mapping is not asked to guess.
 */
export interface EmployeeFormSource {
  readonly firstName: string;
  readonly lastName: string;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly timezone: string;
  readonly skills: readonly string[];
  readonly employmentType?: 'FULL_TIME' | 'PART_TIME' | 'CONTRACTOR' | 'INTERN';
  readonly weeklyCapacityHours?: number;
  readonly emergencyContact?: string | null;
}
