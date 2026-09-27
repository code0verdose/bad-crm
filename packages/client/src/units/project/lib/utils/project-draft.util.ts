import {
  DEFAULT_PROJECT_COLOR,
  type ProjectEditFormValues,
  type ProjectFormValues,
} from '@units/project/model';
import {
  type ProjectDraftValues,
  type ProjectEditSource,
  type ProjectPatchValues,
} from '@units/project/types';

/**
 * The translations between what the project form holds and what the contract carries — once, here,
 * instead of in the component that submits.
 *
 * **The dates are calendar days read and written in UTC**, the convention the permission-override
 * form set (`units/iam/lib/utils/override-expiry.util.ts`): the form asks for a day, the contract
 * wants an instant, and «the start of that day, UTC» is the one reading that means the same instant
 * to every member of an organization spread over time zones.
 */

/** `YYYY-MM-DD` of an instant, UTC; `''` for «not set» — what an empty `<input type="date">` holds. */
export const calendarDayOf = (instant: string | null): string =>
  instant === null ? '' : new Date(instant).toISOString().slice(0, 10);

/** The start of the day, UTC, as the contract's `date-time`; `null` for an empty field. */
export const instantOfDay = (day: string): string | null =>
  day === '' ? null : new Date(`${day}T00:00:00.000Z`).toISOString();

/** Trimmed, and `null` rather than `''` — `PATCH` replaces, so «nothing written» must be sayable. */
const proseOrNull = (text: string): string | null => {
  const trimmed = text.trim();

  return trimmed === '' ? null : trimmed;
};

/** The edit form as the `PATCH` body. Trimmed here: Mantine hands the raw values to the handler. */
export const toProjectPatch = (values: ProjectEditFormValues): ProjectPatchValues => ({
  name: values.name.trim(),
  description: proseOrNull(values.description),
  leadId: values.leadId,
  color: values.color,
  startedAt: instantOfDay(values.startedAt),
  dueAt: instantOfDay(values.dueAt),
});

/**
 * The create form as the `POST` body. The key is sent as typed-and-trimmed: the server normalizes it
 * (upper-case) itself, and a second normalization here would only be a second copy of the rule.
 */
export const toProjectDraft = (values: ProjectFormValues): ProjectDraftValues => ({
  ...toProjectPatch(values),
  key: values.key.trim(),
  visibility: values.visibility,
});

/**
 * What the create form starts from. The lead defaults to the reader — creating a project one leads
 * oneself is allowed, and «nobody» is refused — and the visibility to the contract's own default.
 */
export const newProjectValues = (readerId: string | undefined): ProjectFormValues => ({
  key: '',
  name: '',
  description: '',
  visibility: 'PUBLIC_ORG',
  leadId: readerId ?? '',
  color: DEFAULT_PROJECT_COLOR,
  startedAt: '',
  dueAt: '',
});

/** What the settings form starts from: the stored project, in the form's own terms. */
export const projectEditValuesOf = (project: ProjectEditSource): ProjectEditFormValues => ({
  name: project.name,
  description: project.description ?? '',
  leadId: project.leadId,
  color: project.color,
  startedAt: calendarDayOf(project.startedAt),
  dueAt: calendarDayOf(project.dueAt),
});
