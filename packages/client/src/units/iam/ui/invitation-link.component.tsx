import { Alert, Button, Code, Group, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { type IamApi } from '@units/iam';

export interface InvitationLinkProps {
  readonly invitation: IamApi.MintedInvitation;
  readonly onCopy: (url: string) => void;
  /**
   * The opening sentence, which is the one thing the two callers say differently: the invite screen
   * has just created an invitation, the list has just replaced the link of one that existed.
   *
   * A prop rather than a second component, because everything else — the warning when this
   * installation has no relay, the copy control, the expiry — is the same panel, and criterion 3 of
   * STORY-012-08 asks for that panel and not for a variant of it. It defaults to the invite screen's
   * sentence so that caller stays untouched.
   */
  readonly titleKey?: string;
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
export function InvitationLink({
  invitation,
  onCopy,
  titleKey = 'members.invite.created',
}: InvitationLinkProps) {
  const { t, i18n } = useTranslation();

  return (
    <Stack gap="sm" role="status">
      <Text fw={600}>{t(titleKey, { email: invitation.email })}</Text>

      {invitation.mailDispatched ? (
        <Text>{t('members.invite.sent', { email: invitation.email })}</Text>
      ) : (
        <Alert color="warning" variant="light">
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

      <Text c="var(--bc-text-muted)" size="sm">
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
