import { Alert, Button, Code, Group, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { type IamApi } from '@units/iam';

export interface InvitationLinkProps {
  readonly invitation: IamApi.MintedInvitation;
  readonly onCopy: (url: string) => void;
}

/**
 * The link, once.
 *
 * It is on the screen whether or not a letter went out, because the server cannot produce it a
 * second time: what changes with `mailDispatched` is the sentence beside it. Without a relay the
 * warning is the whole point of the screen — an installation with no `SMTP_URL` (NFR-9) would
 * otherwise look like it had just sent something.
 *
 * `role="status"` rather than an alert: nothing went wrong, and a screen reader should hear that
 * the invitation exists without being interrupted mid-sentence.
 */
export function InvitationLink({ invitation, onCopy }: InvitationLinkProps) {
  const { t, i18n } = useTranslation();

  return (
    <Stack gap="sm" role="status">
      <Text fw={600}>{t('members.invite.created', { email: invitation.email })}</Text>

      {invitation.mailDispatched ? (
        <Text>{t('members.invite.sent', { email: invitation.email })}</Text>
      ) : (
        <Alert color="yellow" variant="light">
          {t('members.invite.noMail')}
        </Alert>
      )}

      <Text size="sm">{t('members.invite.linkHint')}</Text>
      <Group align="center" gap="sm" wrap="nowrap">
        <Code aria-label={t('members.invite.linkLabel')}>{invitation.inviteUrl}</Code>
        <Button
          onClick={() => {
            onCopy(invitation.inviteUrl);
          }}
          variant="light"
        >
          {t('members.invite.copy')}
        </Button>
      </Group>

      <Text c="dimmed" size="sm">
        {t('members.invite.expires', {
          date: SharedLib.formatDate(
            invitation.expiresAt,
            i18n.language,
            SharedLib.resolveTimeZone(),
          ),
        })}
      </Text>
    </Stack>
  );
}
