import { type ProjectVisibility } from '@units/project/model/enums/project-visibility.enums.js';

/** The two sentences of the summary for one direction: a counted one, and the one for nobody. */
export interface VisibilityImpactCopy {
  /** A plural family (`_one`/`_other`, `_one`/`_few`/`_many`) with `{{count}}`. */
  readonly countedKey: string;
  /** Said instead when the count is `0` — «0 colleagues lose access» reads as a glitch. */
  readonly noneKey: string;
}

/**
 * The summary of a change of visibility, by the visibility it moves to: closing a project is
 * about who loses it, opening one — about who gains it.
 */
export const PROJECT_VISIBILITY_IMPACT_COPY: Readonly<
  Record<ProjectVisibility, VisibilityImpactCopy>
> = {
  PRIVATE: {
    countedKey: 'projects.visibility.close.impact',
    noneKey: 'projects.visibility.close.impactNone',
  },
  PUBLIC_ORG: {
    countedKey: 'projects.visibility.open.impact',
    noneKey: 'projects.visibility.open.impactNone',
  },
};
