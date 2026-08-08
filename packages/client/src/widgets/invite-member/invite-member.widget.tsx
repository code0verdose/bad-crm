import { Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { notify } from '@shared/ui';
import { IamModel, IamService, IamUi } from '@units/iam';

/**
 * Inviting a colleague: the form, and afterwards the link it produced.
 *
 * The widget is the composition point. It asks the unit for the roles the caller may hand out, calls
 * the unit's mutation, and keeps the one piece of state that has nowhere else to live — **the minted
 * invitation**, which exists in exactly one response and can never be fetched again. That is why it
 * is component state rather than a query: there is nothing to re-read.
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
  const create = IamService.IamMutations.useCreateInvitation();

  const options = (roles.data ?? []).map((role) => ({ value: role.id, label: role.name }));

  return (
    <Stack gap="lg">
      <IamUi.InviteForm
        defaultLocale={IamModel.invitationLocaleOf(i18n.language)}
        isPending={create.isPending}
        onSubmit={(values) => {
          create.mutate({
            email: values.email,
            // `''` is «no role for now»: the select has no empty state of its own, and the contract
            // spells that as `null`.
            roleId: values.roleId === '' ? null : values.roleId,
            locale: values.locale,
          });
        }}
        roles={options}
      />

      {create.data === undefined ? null : (
        <IamUi.InvitationLink
          invitation={create.data}
          onCopy={(url) => {
            void navigator.clipboard.writeText(url).then(
              () => {
                // One signal, with a stable id: copying twice updates the same notification rather
                // than stacking two (`rules/errors-and-toasts.mdc` §2).
                notify.success({
                  id: 'invitation-link-copied',
                  messageKey: 'members.invite.copied',
                });
              },
              () => {
                // The clipboard is refused often enough to matter — permission denied, an insecure
                // origin, a browser that wants a fresher gesture. Silence here is the worst possible
                // answer on this screen: the link is shown **once**, so a person who believes they
                // copied it and did not has lost it. `void … .then(onlySuccess)` satisfied the
                // linter and dropped the rejection into the global handler, where the user never
                // sees it.
                notify.error({
                  id: 'invitation-link-copied',
                  messageKey: 'members.invite.copyFailed',
                });
              },
            );
          }}
        />
      )}
    </Stack>
  );
}
