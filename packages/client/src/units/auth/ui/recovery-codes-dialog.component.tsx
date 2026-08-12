import { Alert, Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PAGE_TITLE_ID } from '@shared/ui';
import { downloadRecoveryCodes } from '@units/auth/lib';

import { RecoveryCodesList } from './recovery-codes-list.component.js';

export interface RecoveryCodesDialogProps {
  readonly codes: readonly string[];
  /** Called once the person states they have saved them. The codes are dropped from memory then. */
  readonly onConfirmed: () => void;
}

/**
 * The ten codes, shown once in the life of a set — and the only screen in this product where
 * closing a window destroys something irreplaceable.
 *
 * Everything unusual about it follows from that one fact:
 *
 * - **It cannot be dismissed by accident.** The overlay does not close it, `Escape` does not close
 *   it, and both close controls are inert until the person states they have the codes. That is a
 *   deliberate departure from `rules/a11y.mdc` §6 («Esc закрывает»), and the reason it is not a
 *   keyboard trap in the WCAG 2.1.2 sense is that the way out is inside the dialog, reachable by
 *   Tab, operable with Space, and named on screen — the standard the criterion actually sets is
 *   «focus can be moved away with the keyboard, and the method is documented». A dialog that Escape
 *   dismissed would trade that for ten credentials that exist nowhere else.
 * - **It offers a file and a printout before it offers a way out.** «Write them down» is advice
 *   nobody follows at the moment they are given it.
 * - **It renders only while the codes exist.** The component is mounted by the presence of a set
 *   and unmounted by `onConfirmed`, so the confirmation state cannot survive into a second set —
 *   a reissue starts from an unticked box, always.
 *
 * The mutations behind it carry `gcTime: 0` and are reset by `onConfirmed`, so «closed» means
 * «gone from this tab», not «hidden».
 */
export function RecoveryCodesDialog({ codes, onConfirmed }: RecoveryCodesDialogProps) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);

  /**
   * Where the focus goes when this closes, decided here rather than left to `returnFocus`.
   *
   * Mantine's default — «back to whatever had focus when the dialog opened» — cannot work for this
   * dialog, twice over, and both reasons were measured rather than reasoned about:
   *
   * - **the control that opened it is `loading` at that moment**, so a browser has already taken
   *   focus off it before Mantine records anything;
   * - **after an enrolment the control does not exist at all.** Confirming makes the counter behind
   *   the screen say «enrolled», which replaces the confirm form with the enrolled view. Focus
   *   returned to a detached node is focus on `<body>`: a keyboard user is dumped at the top of the
   *   document and tabs through the whole shell to get back.
   *
   * So focus goes to the page's `h1`, which is what the route announcer already does when what a
   * page is *about* changes (`rules/a11y.mdc` §21) — and what this page is about has just changed.
   * The heading carries `tabIndex={-1}` for exactly this.
   *
   * The microtask is not decoration: `onConfirmed` schedules the unmount, and the focus trap is
   * still live for the rest of this event. Moving focus inside the handler would be undone by the
   * trap; moving it once the commit has happened lands where it is meant to.
   */
  const close = (): void => {
    onConfirmed();
    queueMicrotask(() => {
      document.getElementById(PAGE_TITLE_ID)?.focus();
    });
  };

  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('security.codes.dialog.close'), disabled: !saved }}
      // The overlay is not a way out: a stray click outside a dialog is the cheapest possible way
      // to lose ten credentials, and there is nothing behind it worth clicking on yet.
      closeOnClickOutside={false}
      closeOnEscape={saved}
      onClose={close}
      opened
      // One thing decides where focus lands, and it is `close` above. Left on, Mantine would also
      // aim at a node that is either disabled or gone, and the two would race.
      returnFocus={false}
      size="lg"
      title={t('security.codes.dialog.title')}
    >
      <Stack gap="md">
        <Alert color="yellow" title={t('security.codes.dialog.onceTitle')} variant="light">
          <Text size="sm">{t('security.codes.dialog.onceDescription')}</Text>
        </Alert>

        <RecoveryCodesList codes={codes} />

        <Group data-bc-print-hidden gap="sm">
          <Button
            onClick={() => {
              downloadRecoveryCodes(codes, t('security.codes.file.header'));
            }}
            variant="default"
          >
            {t('security.codes.dialog.download')}
          </Button>
          <Button
            onClick={() => {
              globalThis.print();
            }}
            variant="default"
          >
            {t('security.codes.dialog.print')}
          </Button>
        </Group>

        <Checkbox
          checked={saved}
          data-bc-print-hidden
          description={t('security.codes.dialog.savedHint')}
          label={t('security.codes.dialog.saved')}
          onChange={(event) => {
            setSaved(event.currentTarget.checked);
          }}
        />

        <Button data-bc-print-hidden disabled={!saved} onClick={close}>
          {t('security.codes.dialog.done')}
        </Button>
      </Stack>
    </Modal>
  );
}
