import { Button, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { InvitationList } from '@widgets/invitation-list';
import { IamService } from '@units/iam';

/**
 * `/admin/members/invitations` — composition only (`rules/frontend-fsd.mdc` rule 7).
 *
 * The way back to the form is in the header rather than in the empty state alone: this screen is
 * reached from the directory and from the form, and «invite somebody else» is the next thing an
 * administrator does after re-issuing a link.
 */
export function AdminMembersInvitationsPage() {
  const { t } = useTranslation();
  const { can } = IamService.IamHooks.useCan();

  return (
    <Stack gap="md">
      <SharedUi.PageHeader
        actions={
          can('invitation:create') ? (
            <Button component={Link} to="/admin/members/invite" variant="light">
              {t('members.invite.title')}
            </Button>
          ) : undefined
        }
        breadcrumbs={<Breadcrumbs />}
        titleKey="members.invitations.title"
      />
      <Text>{t('members.invitations.description')}</Text>
      <InvitationList />
    </Stack>
  );
}
