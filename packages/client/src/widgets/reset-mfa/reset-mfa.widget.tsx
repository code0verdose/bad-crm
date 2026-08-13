import { Button, Group } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { ResetMfaDialog } from './ui/reset-mfa-dialog.component.js';

export interface ResetMfaProps {
  readonly userId: string;
  /** The address the confirmation is typed back against — see the dialog for why it is the address. */
  readonly email: string;
}

/**
 * The way back in for a colleague who lost their authenticator **and** every recovery code, on the
 * personnel card — the administrative twin of `widgets/disable-totp`, which is the same operation
 * done to oneself.
 *
 * **A section at the foot of the card rather than a second button in the header.** The header
 * already carries the offboarding control, and a page heading with two red buttons in it is the row
 * of interchangeable destructive actions `rules/design-system.mdc` §17 exists to prevent: a
 * destructive setting belongs after the things it destroys, gathered and labelled, not beside the
 * title. This is the identical shape `DisableTotp` takes at the foot of `/settings/security`, which
 * is the point — the two screens are the two halves of one operation and should not have to be
 * learned separately.
 *
 * **Below the tabs rather than inside one.** What a reset is about is the *account*, not the
 * personnel form and not the permission matrix; putting it in either would make it appear and
 * disappear as somebody switches between two tabs that have nothing to do with it.
 *
 * **No `DangerZone` wrapper**, and this is where one would eventually go: §17 collects destructive
 * settings, and the offboarding control in the header is the second member such a container would
 * need. Moving it is a change to a shipped screen and its suite rather than a detail of this one,
 * so it is named here rather than done in passing — a container with a single child is the wrapper
 * §7 says not to write.
 *
 * **The trigger takes no focus management of its own.** Unlike `DisableTotp` — whose section stops
 * being drawn the moment it succeeds, so its focus has nowhere to return to — this section outlives
 * every outcome: the card is still a card, the button is still there, and Mantine's `Modal` returns
 * the focus to it (`rules/a11y.mdc` §6).
 */
export function ResetMfa({ userId, email }: ResetMfaProps) {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);

  return (
    <SharedUi.Section descriptionKey="security.reset.description" titleKey="security.reset.title">
      {/* A `Group` so the button keeps its own width: a `Stack` stretches its children. */}
      <Group>
        <Button color="danger" onClick={open} variant="light">
          {t('security.reset.trigger')}
        </Button>
      </Group>

      <ResetMfaDialog email={email} onClose={close} opened={opened} userId={userId} />
    </SharedUi.Section>
  );
}
