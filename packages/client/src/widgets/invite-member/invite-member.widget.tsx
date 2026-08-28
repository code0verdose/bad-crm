import { Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { IamModel, IamService, IamUi } from '@units/iam';

/**
 * Inviting a colleague: the form, and afterwards the link it produced.
 *
 * The widget is the composition point. It asks the unit for the roles the caller may hand out and
 * hands the form to the unit's hook; the minted invitation comes back through that hook, because it
 * exists in exactly one response and can never be fetched again — there is nothing to re-read, and
 * nothing here decides how a form becomes a request body.
 *
 * The role list is fetched **only if the caller may read roles**. Inviting and reading roles are two
 * capabilities, and a person who holds one without the other can still send an invitation — with no
 * role, which is what the empty select then offers. Asking anyway would put a 403 on a screen that
 * is working correctly.
 */
export function InviteMember() {
  const { i18n } = useTranslation();
  const { can } = IamService.IamHooks.useCan();
  const roles = IamService.IamQueries.useRolesMatrixQuery({ enabled: can('role:read') });
  const draft = IamService.IamHooks.useInvitationDraft();

  const options = (roles.data ?? []).map((role) => ({ value: role.id, label: role.name }));

  return (
    <Stack gap="lg">
      <IamUi.InviteForm
        defaultLocale={IamModel.invitationLocaleOf(i18n.language)}
        isPending={draft.isPending}
        onSubmit={draft.send}
        roles={options}
      />

      {draft.minted === undefined ? null : <IamUi.InvitationLink invitation={draft.minted} />}
    </Stack>
  );
}
