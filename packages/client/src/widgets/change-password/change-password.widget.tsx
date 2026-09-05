import { SharedUi } from '@shared';

import { AuthService, AuthUi } from '@units/auth';

/**
 * Changing one's own password, on `/settings/security`.
 *
 * The composition point (`rules/frontend-fsd.mdc` rule 7): it asks the unit for the operation and
 * hands the form what the form renders. Nothing here knows that a request is involved.
 *
 * **It owns its controller, unlike the two sections below it.** The recovery-code and enrolment
 * controllers are held by the page because each answers with ten codes that exist nowhere else and
 * must outlive the section that produced them. Nothing this operation answers with survives its own
 * success — a 204 and an emptied form — so there is nothing for the page to hold.
 *
 * **It is outside the `DataState` that wraps the second-factor sections**, and that is the point of
 * putting it here rather than inside. Those sections are drawn from the recovery-code counter, and a
 * counter that fails to load would otherwise take the password form down with it — on the screen
 * somebody opens precisely because they think their password has leaked.
 */
export function ChangePassword() {
  const change = AuthService.usePasswordChange();

  return (
    <SharedUi.Section
      descriptionKey="security.password.description"
      titleKey="security.password.title"
    >
      <AuthUi.ChangePasswordForm
        failure={change.failure}
        isPending={change.isPending}
        onSubmit={change.change}
      />
    </SharedUi.Section>
  );
}
