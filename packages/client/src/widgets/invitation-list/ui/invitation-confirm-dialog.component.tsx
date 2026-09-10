import { Alert, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { type SharedApi } from '@shared';

import { INVITATION_ACTION_COPY, type InvitationActionKind } from '@widgets/invitation-list/lib';
import { IamUi, type IamApi } from '@units/iam';

export interface InvitationConfirmDialogProps {
  readonly opened: boolean;
  readonly action: InvitationActionKind;
  /** The address the row is about, named in the question so «which row was I on» cannot be wrong. */
  readonly email: string;
  readonly isPending: boolean;
  /** The refusal as a sentence key, chosen from the `code`. Absent while nothing has been refused. */
  readonly failure?: SharedApi.ErrorMessage;
  /** The link a successful re-issue produced — the only copy that will ever exist. */
  readonly minted?: IamApi.MintedInvitation;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * One confirmation for both operations on an existing invitation.
 *
 * They are the same policy — say what will be true afterwards, ask, and show the refusal where the
 * button was pressed — so they are one component rather than two nearly identical ones
 * (`rules/design-system.mdc` §8). What differs is the sentences, and those come from
 * `INVITATION_ACTION_COPY` as keys.
 *
 * **The consequences are listed before the button, not reported after it.** For a re-issue the part
 * people are surprised by later is that the previous link stops working — somebody may already have
 * been sent it. For a revoke it is that there is no undoing it.
 *
 * **A refusal is rendered here, not toasted.** The dialog is `aria-modal="true"`, so while it is
 * open nothing outside it is in the accessibility tree: a toast in the corner is, for a
 * screen-reader user, no signal at all. Both mutations therefore declare their own `onError` and the
 * global toast stands aside (`rules/errors-and-toasts.mdc` §2–§3, `rules/tanstack-query.mdc` §10).
 *
 * **A successful re-issue keeps the dialog open** and puts the link in it, through the very panel
 * the invite screen uses. Closing on success would hide the one thing worth reading, and it cannot
 * be fetched again: the server keeps a digest. A successful revoke does the opposite — the caller
 * closes the dialog, because the row it was about is gone.
 */
export function InvitationConfirmDialog({
  opened,
  action,
  email,
  isPending,
  failure,
  minted,
  onConfirm,
  onClose,
}: InvitationConfirmDialogProps) {
  const { t } = useTranslation();
  const copy = INVITATION_ACTION_COPY[action];
  /**
   * A spread rather than `color={… : undefined}`: under `exactOptionalPropertyTypes` an explicit
   * `undefined` is not «no colour», and Mantine's own default is not spellable. Built here rather
   * than in the markup because a bare string inside JSX is text as far as `i18next` can tell.
   */
  const confirmColor = copy.isDestructive ? { color: 'danger' as const } : {};

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it reaches
      // a screen reader as «button» — axe reports it as `button-name`.
      closeButtonProps={{ 'aria-label': t('members.invitations.close') }}
      onClose={onClose}
      opened={opened}
      title={t(copy.titleKey)}
    >
      {minted === undefined ? (
        <Stack gap="md">
          <Text>{t(copy.descriptionKey, { email })}</Text>
          <List size="sm">
            {copy.consequenceKeys.map((key) => (
              <List.Item key={key}>{t(key)}</List.Item>
            ))}
          </List>

          {failure !== undefined && (
            // `role="alert"`, so it is announced rather than merely drawn: the operator's attention
            // is on the button they just pressed (`rules/a11y.mdc` §13). The text comes from the
            // `code`, never from `detail` — the technical half went to the log.
            <Alert color="danger" role="alert" title={t(copy.failedTitleKey)} variant="light">
              <Text size="sm">{t(failure.key, failure.values ?? {})}</Text>
            </Alert>
          )}

          <Group>
            <Button onClick={onClose} variant="default">
              {t('members.invitations.cancel')}
            </Button>
            <Button loading={isPending} onClick={onConfirm} {...confirmColor}>
              {t(copy.confirmKey)}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          <IamUi.InvitationLink invitation={minted} titleKey="members.invitations.reissued" />
          <Group>
            <Button onClick={onClose} variant="default">
              {t('members.invitations.close')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
