import { type TeamForm } from '@units/team/model/validation/team-form.schema.js';
import { type TeamDraftValues } from '@units/team/types';

/**
 * The form as the request body.
 *
 * One line of it is the whole reason this exists: an empty description is `null`, never `''`. The
 * contract's field is nullable prose and `PATCH /teams/{teamId}` **replaces** rather than merges, so
 * «nothing written» has to be expressible — and `''` would store an empty paragraph that reads as
 * a description somebody wrote and then deleted the text of.
 *
 * Trimmed here rather than in the schema, because a Zod `.trim()` cleans the value it *validates*
 * and Mantine hands the component's raw values to the submit handler.
 */
export const toTeamDraft = (values: TeamForm): TeamDraftValues => {
  const description = values.description.trim();

  return {
    name: values.name.trim(),
    slug: values.slug.trim(),
    description: description === '' ? null : description,
  };
};
