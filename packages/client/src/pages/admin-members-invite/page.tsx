import { Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { InviteMember } from '@widgets/invite-member';

/** `/admin/members/invite` — composition only (`rules/frontend-fsd.mdc` rule 7). */
export function AdminMembersInvitePage() {
  const { t } = useTranslation();

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="members.invite.title" />
      <Text>{t('members.invite.description')}</Text>
      <InviteMember />
    </Stack>
  );
}
