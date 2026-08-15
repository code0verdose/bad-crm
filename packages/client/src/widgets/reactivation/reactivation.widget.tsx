import { Button, Group } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { ReactivationDialog } from './ui/reactivation-dialog.component.js';

/** Where the focus goes once the dialog is gone, and it depends on what happened in it. */
type FocusReturn = 'trigger' | 'heading';

export interface ReactivationProps {
  readonly userId: string;
  /** Whose account the dialog is about — shown, never typed back. See the dialog for why. */
  readonly email: string;
}

/**
 * The way back for a colleague who was switched off, at the foot of their personnel card.
 *
 * **A section rather than a button in the header.** The header already carries the offboarding
 * control, and the two are opposites: a heading row holding «Deactivate» beside «Bring back» is a
 * pair of one-click switches for the most consequential state a person has. Down here it sits with
 * the 2FA reset, after everything that is about keeping the record usable
 * (`rules/design-system.mdc` §17).
 *
 * **It is drawn only while there is something to bring back** — the page decides that from
 * `status`, not from this widget — which is precisely why the focus below has two destinations.
 *
 * **The trigger is not `danger`.** Every other control on this card destroys something; this one
 * restores access, and colouring it like its neighbours would make the row of red buttons that
 * `rules/design-system.mdc` §17 exists to prevent. It is still confirmed, because what comes back
 * with the account is a set of roles somebody granted months ago.
 */
export function Reactivation({ userId, email }: ReactivationProps) {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * A new object per close, so the effect below runs every time — including twice in a row for the
   * same destination.
   */
  const [closedTo, setClosedTo] = useState<{ readonly at: FocusReturn } | undefined>(undefined);

  /**
   * Moving the focus after the trap that owned it has been unmounted — a real side effect on the
   * DOM, which is the one thing `useEffect` is still for (`rules/frontend-fsd.mdc` rule 11).
   *
   * It cannot be done in the handler: Mantine's focus trap is live for the rest of that event and
   * pulls the focus straight back inside. An effect runs after the commit that removed the dialog,
   * which is exactly the moment both destinations below become reachable.
   *
   * **Two destinations, because the trigger is not always still there.** After a cancellation it is,
   * and `rules/a11y.mdc` §6 asks for it. After a successful run this whole section is about to stop
   * being drawn — the record is read again on close and the account now answers «active» — and focus
   * returned to a detached node is focus on `<body>`, dumping a keyboard user at the top of the
   * shell. So it goes to the page's `h1`, which is where the route announcer already sends it when
   * what a page is *about* changes (§21). What this page is about has just changed. The shape is
   * `widgets/disable-totp`'s, restated here because the condition is the same one and the answer had
   * to be decided again rather than inherited.
   */
  useEffect(() => {
    if (closedTo === undefined) return;

    const target =
      closedTo.at === 'heading'
        ? document.getElementById(SharedUi.PAGE_TITLE_ID)
        : triggerRef.current;

    target?.focus();
  }, [closedTo]);

  return (
    <SharedUi.Section
      descriptionKey="members.reactivate.description"
      titleKey="members.reactivate.title"
    >
      {/* A `Group` so the button keeps its own width: a `Stack` stretches its children. */}
      <Group>
        <Button onClick={open} ref={triggerRef} variant="light">
          {t('members.reactivate.trigger')}
        </Button>
      </Group>

      <ReactivationDialog
        email={email}
        onClose={(at) => {
          close();
          setClosedTo({ at });
        }}
        opened={opened}
        userId={userId}
      />
    </SharedUi.Section>
  );
}
