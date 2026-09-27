import { isApiError, VALIDATION_ISSUE_MESSAGE_KEY, type ErrorMessage } from '@shared/api';

import { projectRefusalMessage } from './project-refusal.util.js';

/** Every field the project forms have — the create page has all of them, settings all but two. */
export const PROJECT_FORM_FIELDS = [
  'key',
  'name',
  'description',
  'visibility',
  'leadId',
  'color',
  'startedAt',
  'dueAt',
] as const;

export type ProjectFormField = (typeof PROJECT_FORM_FIELDS)[number];

export interface ProjectFormFailure {
  /** Refusals that are about one field — rendered under it, never as a toast (`errors-and-toasts` §4). */
  readonly fields: Partial<Readonly<Record<ProjectFormField, ErrorMessage>>>;
  /** A refusal about the request as a whole — rendered above the fields, `role="alert"`. */
  readonly notice: ErrorMessage | undefined;
}

const NONE: ProjectFormFailure = { fields: {}, notice: undefined };

const isFormField = (path: string): path is ProjectFormField =>
  (PROJECT_FORM_FIELDS as readonly string[]).includes(path);

/**
 * Where a refused project write is shown: under the field it is about, or above the form.
 *
 * The **general** binding of `errors[].path` to fields (STORY-008-03) does not exist yet, so this is
 * per-form, like the registration's (`use-registration.hook.ts`): the contract names the fields in
 * `errors[].path` exactly as the form names them, so the path is the field.
 *
 * Four refusals the server makes about one field are routed to that field:
 * - `409 project_already_exists` — the key is taken inside the organization;
 * - `404 user_not_found` / `409 member_not_active` on a write that names a lead — the chosen lead is
 *   not (or no longer) a live account here;
 * - `403` with reason `self_assignment_forbidden` — handing the lead to oneself on edit;
 * - `422` issues — each under its own field; `dueAt` before `startedAt` in the words the form itself
 *   uses, so the person reads the same sentence whichever side caught it.
 *
 * Everything else — a rate limit, a `403` for a right that went stale, a 500 — is one sentence about
 * the request, and a `422` naming no field the form has goes there too, so a refusal is never silent.
 */
export const projectFormFailure = (error: unknown): ProjectFormFailure => {
  if (error === null || error === undefined) return NONE;
  if (!isApiError(error)) return { fields: {}, notice: projectRefusalMessage(error) };

  if (error.code === 'project_already_exists') {
    return { fields: { key: { key: 'projects.field.keyTaken' } }, notice: undefined };
  }
  if (error.code === 'user_not_found') {
    return { fields: { leadId: { key: 'projects.field.leadUnavailable' } }, notice: undefined };
  }
  if (error.code === 'member_not_active') {
    return { fields: { leadId: { key: 'projects.field.leadInactive' } }, notice: undefined };
  }
  if (error.reason === 'self_assignment_forbidden') {
    return { fields: { leadId: { key: 'projects.field.leadSelf' } }, notice: undefined };
  }

  if (error.code === 'validation_failed') {
    const fields: Partial<Record<ProjectFormField, ErrorMessage>> = {};

    for (const issue of error.issues) {
      if (!isFormField(issue.path) || issue.path in fields) continue;

      fields[issue.path] =
        issue.path === 'dueAt' && issue.code === 'custom'
          ? { key: 'projects.field.dueBeforeStart' }
          : { key: VALIDATION_ISSUE_MESSAGE_KEY[issue.code] };
    }

    if (Object.keys(fields).length > 0) return { fields, notice: undefined };
  }

  return { fields: {}, notice: projectRefusalMessage(error) };
};
