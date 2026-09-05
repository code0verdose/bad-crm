import { Button, Group } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { DisableTotpDialog } from './ui/disable-totp-dialog.component.js';

/** Where the focus goes once the confirmation is gone, and it depends on why it went. */
type FocusReturn = 'trigger' | 'heading';

/**
 * The way out of the second factor, on `/settings/security` — drawn only while there is one to take.
 *
 * It is the last of the second-factor sections rather than a control beside «two-factor
 * authentication is on», and that is deliberate: everything above it is about keeping the factor
 * working, and a destructive setting belongs after the things it destroys, not next to them
 * (`rules/design-system.mdc` §17). It stopped being the last section of the *screen* when
 * STORY-006-04 added the session list below — that section is not a setting, it is the state these
 * settings produce.
 *
 * **No `DangerZone` wrapper.** §17 collects destructive settings into one, and there is exactly one
 * on this screen — the administrator reset lives on somebody else's profile, behind
 * `user:reset_mfa`, and will never appear here. A container with a single child is the wrapper §7
 * says not to write.
 *
 * **The confirmation is mounted by being open**, not hidden with a prop. Its form and its mutation
 * are then born and buried with it: a second attempt after a cancelled first cannot inherit a typed
 * password or a stale refusal, and there is no `reset()` anywhere that has to remember to run.
 */
export function DisableTotp() {
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
   * pulls the focus straight back inside. A microtask is not enough either — the successful path
   * closes from a promise callback, whose commit has not happened by the time microtasks run, so the
   * dialog would still be mounted. An effect runs after the commit that removed it, which is exactly
   * the moment both destinations below become reachable.
   *
   * **Two destinations, because the trigger is not always there to return to.** After a cancellation
   * it is, and `rules/a11y.mdc` §6 asks for it. After a successful disable the section this button
   * lives in is about to stop being drawn — the counter behind the screen has started answering
   * «off» — and focus returned to a detached node is focus on `<body>`, dumping a keyboard user at
   * the top of the shell. So it goes to the page's `h1`, which is where the route announcer already
   * sends it when what a page is *about* changes (§21). What this page is about has just changed.
   */
  useEffect(() => {
    if (closedTo === undefined) return;

    const target =
      closedTo.at === 'heading'
        ? document.getElementById(SharedUi.PAGE_TITLE_ID)
        : triggerRef.current;

    target?.focus();
  }, [closedTo]);

  const dismiss = (at: FocusReturn): void => {
    close();
    setClosedTo({ at });
  };

  return (
    <SharedUi.Section
      descriptionKey="security.disable.description"
      titleKey="security.disable.title"
    >
      {/* A `Group` so the button keeps its own width: a `Stack` stretches its children. */}
      <Group>
        <Button color="danger" onClick={open} ref={triggerRef} variant="light">
          {t('security.disable.trigger')}
        </Button>
      </Group>

      {opened && (
        <DisableTotpDialog
          onCancel={() => {
            dismiss('trigger');
          }}
          onDisabled={() => {
            dismiss('heading');
          }}
        />
      )}
    </SharedUi.Section>
  );
}
