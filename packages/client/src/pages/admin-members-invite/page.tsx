import { Button, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { InviteMember } from '@widgets/invite-member';
import { IamService } from '@units/iam';

/** `/admin/members/invite` — composition only (`rules/frontend-fsd.mdc` rule 7). */
export function AdminMembersInvitePage() {
  const { t } = useTranslation();
  const { can } = IamService.IamHooks.useCan();

  return (
    <Stack gap="md">
      <SharedUi.PageHeader
        actions={
          /*
            The way to the list of open invitations, from the screen that creates them. The link is
            shown once and only in the answer below; somebody who closed this tab without copying it
            has nowhere else to go, and creating a second invitation for the same address is refused
            with `409 invitation_already_exists` — a dead end one click wide (STORY-012-08).
          */
          can('invitation:read') ? (
            <Button component={Link} to="/admin/members/invitations" variant="light">
              {t('members.invitations.link')}
            </Button>
          ) : undefined
        }
        breadcrumbs={<Breadcrumbs />}
        titleKey="members.invite.title"
      />
      <Text>{t('members.invite.description')}</Text>
      <InviteMember />
    </Stack>
  );
}
