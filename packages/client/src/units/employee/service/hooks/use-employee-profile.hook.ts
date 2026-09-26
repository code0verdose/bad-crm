import { type EmployeeProfile, type EmployeeProfilePatch } from '@units/employee/api';
import { employeeFormValues } from '@units/employee/lib/utils/employee-form-values.util.js';
import { type EmployeeProfileFormValues } from '@units/employee/model';
import { useEmployeeProfileEditor } from '@units/employee/service/hooks/use-employee-profile-editor.hook.js';
import { useEmployeeProfileQuery } from '@units/employee/service/queries/employee-profile.query.js';

export interface EmployeeProfileCard {
  readonly status: 'pending' | 'error' | 'success';
  /**
   * The document itself, or `undefined` until it arrives.
   *
   * Handed out as well as the form's fields, because the page draws four things from the *record*
   * and not from the form: whether there is an account to switch off, one to reset a second factor
   * on, one to bring back, and whether to say when it was switched off.
   */
  readonly profile: EmployeeProfile | undefined;
  /** What the form starts with, or `undefined` while there is no form to start. */
  readonly initialValues: EmployeeProfileFormValues | undefined;
  /**
   * Whether the document carried the emergency contact at all.
   *
   * «Did the document carry it», not «may this caller edit it»: the contact is self-service, and the
   * key is absent exactly when the server placed this caller outside the personal audience for this
   * person. `false` while there is no document, which is what the form renders anyway.
   */
  readonly carriesEmergencyContact: boolean;
  readonly refetch: () => Promise<unknown>;
  readonly isSaving: boolean;
  readonly save: (patch: EmployeeProfilePatch) => void;
}

/**
 * One personnel card — the read, the write and the mapping between them, as one object the page can
 * render (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the page reached past it.** `pages/employee-profile/page.tsx` called
 * `EmployeeQueries.useEmployeeProfileQuery()` itself, skipping the middle link of the chain (rule
 * 4), and kept the document-to-form mapping in a function declared below the component — where rule
 * 5 allows markup, handlers and hook calls, and `rules/naming-and-structure.mdc` allows no helpers
 * at all.
 *
 * **The permission-shaped decisions stay on the page, and that is not an oversight.** Which controls
 * to offer is a question about the *reader* (`user:suspend`, `user:reset_mfa`, `user:reactivate`)
 * rather than about this record, the answer comes from another unit's hook, and every one of them is
 * a hint the endpoint re-decides on its own authority. Composing two units' hooks is what a page is
 * for; reaching into one unit's query segment is what it is not.
 */
export const useEmployeeProfile = (userId: string): EmployeeProfileCard => {
  const query = useEmployeeProfileQuery(userId);
  const editor = useEmployeeProfileEditor(userId);
  const profile = query.data;

  return {
    status: query.isError ? 'error' : query.isPending ? 'pending' : 'success',
    profile,
    initialValues: profile === undefined ? undefined : employeeFormValues(profile),
    carriesEmergencyContact: profile !== undefined && 'emergencyContact' in profile,
    refetch: () => query.refetch(),
    isSaving: editor.isSaving,
    save: editor.save,
  };
};
