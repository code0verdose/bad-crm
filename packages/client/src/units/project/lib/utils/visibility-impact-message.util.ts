import { type ErrorMessage } from '@shared/api';
import { PROJECT_VISIBILITY_IMPACT_COPY, type ProjectVisibility } from '@units/project/model';

/** The two counts, by shape — `lib` sits below `api` in the unit and does not import it. */
interface VisibilityImpactCounts {
  readonly losingAccess: number;
  readonly gainingAccess: number;
}

/**
 * The sentence of the summary: the count the direction is about — `losingAccess` when the project
 * closes, `gainingAccess` when it opens — in its plural, or the sentence for nobody.
 *
 * The count is the server's (`GET …/visibility-impact`); nothing here decides who reads what.
 */
export const visibilityImpactMessage = (
  target: ProjectVisibility,
  impact: VisibilityImpactCounts,
): ErrorMessage => {
  const copy = PROJECT_VISIBILITY_IMPACT_COPY[target];
  const count = target === 'PRIVATE' ? impact.losingAccess : impact.gainingAccess;

  return count === 0 ? { key: copy.noneKey } : { key: copy.countedKey, values: { count } };
};
