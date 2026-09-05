import { Alert, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SESSION_ACTION_COPY, type SessionActionKind } from '@widgets/active-sessions/lib';

export interface SessionConfirmDialogProps {
  readonly action: SessionActionKind;
  /** The device the question is about, named in it so «which row was I on» cannot be wrong. */
  readonly device: string;
  readonly isPending: boolean;
  /** The refusal as a sentence key, chosen from the `code`. Absent while nothing has been refused. */
  readonly failureKey?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * One confirmation for all three ways of closing a session.
 *
 * They are the same policy — say what will be true afterwards, ask, and show the refusal where the
 * button was pressed — so they are one component rather than three nearly identical ones
 * (`rules/design-system.mdc` §8). What differs is the sentences, and those come from
 * `SESSION_ACTION_COPY` as keys.
 *
 * **`ConfirmDialog` from `shared/ui` is not used because there is not one.** `rules/design-system.mdc`
 * §17 names it and the design system does not ship it; every confirmation in the product today is a
 * `Modal` written where it is used (four of them as of this change). Extracting one *here* would mean
 * designing the shared component against a single caller — the thing §7 says not to do — while this
 * one has a shape the others do not: three variants over two endpoints, one of which signs the reader
 * out. The extraction is worth doing from the four that exist, not from the fifth.
 *
 * **No typed confirmation**, which §17 offers as its third level. What is being destroyed is access
 * *for a device*, not data: nothing is lost that signing in again does not restore, and the one row
 * where that is not quite true — this session — is the one that says so in its own words. Making
 * somebody type a device name to close a laptop they have just realised is not theirs would be
 * ceremony at the moment speed is the point.
 *
 * **The refusal is rendered here rather than left to the global toast.** The dialog is
 * `aria-modal="true"`, so while it is open nothing outside it is in the accessibility tree a screen
 * reader is confined to (`rules/errors-and-toasts.mdc` §2–§3).
 *
 * `returnFocus={false}`: where the focus goes when this closes depends on *why* it closed — back to
 * the button when nothing happened, to the page heading when the row that button lived in is gone.
 * That is one decision and it is made by the widget above, which is the thing that knows both
 * answers.
 */
export function SessionConfirmDialog({
  action,
  device,
  isPending,
  failureKey,
  onConfirm,
  onCancel,
}: SessionConfirmDialogProps) {
  const { t } = useTranslation();
  const copy = SESSION_ACTION_COPY[action];

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it reaches
      // a screen reader as «button» — axe reports it as `button-name`.
      closeButtonProps={{ 'aria-label': t('security.sessions.close') }}
      onClose={onCancel}
      opened
      returnFocus={false}
      title={t(copy.titleKey)}
    >
      <Stack gap="md">
        <Text>{t(copy.descriptionKey, { device })}</Text>

        <List size="sm">
          {copy.consequenceKeys.map((key) => (
            <List.Item key={key}>{t(key)}</List.Item>
          ))}
        </List>

        {failureKey !== undefined && (
          // `role="alert"`, so it is announced rather than merely drawn: attention is on the button
          // that was just pressed (`rules/a11y.mdc` §13). The text comes from the `code`, never from
          // `detail` — the technical half went to the log.
          <Alert
            color="danger"
            role="alert"
            title={t('security.sessions.failed.title')}
            variant="light"
          >
            <Text size="sm">{t(failureKey)}</Text>
          </Alert>
        )}

        {/* Cancel first in the DOM: the safe choice is the one a keyboard reaches without aiming
            (`rules/a11y.mdc` §6). */}
        <Group justify="flex-end">
          <Button onClick={onCancel} variant="default">
            {t('security.sessions.cancel')}
          </Button>
          <Button color="danger" loading={isPending} onClick={onConfirm}>
            {t(copy.confirmKey)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
