import { Alert, Button, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedApi } from '@shared';

import { EmployeeService } from '@units/employee';

import { ResetMfaReport } from './reset-mfa-report.component.js';

export interface ResetMfaDialogProps {
  readonly opened: boolean;
  readonly userId: string;
  /**
   * Typed back by the administrator to confirm — the **email address** of the colleague whose
   * second factor is about to be removed. See the note on the confirmation below for why it is the
   * address and not a name.
   */
  readonly email: string;
  readonly onClose: () => void;
}

/**
 * Taking somebody else's second factor off, behind the only barrier this operation has.
 *
 * **The address has to be typed, and that is a judgement about *this* operation** rather than a
 * habit copied from the offboarding dialog beside it (`rules/design-system.mdc` §17 offers three
 * levels; `ux-architecture.md` reserves the top one for deleting a person or a container). What
 * puts this action on the top level is the sentence `docs/api/openapi.yaml` opens with: «neither a
 * password nor a code is asked of the caller — `user:reset_mfa` is the proof». Every other
 * destructive path in this product has something else standing in the way — the self-service
 * disable re-proves both factors, disbanding a team leaves every account intact — and this one has
 * nothing at all between a click and a colleague's account dropping to a password alone with their
 * recovery codes destroyed. The card is reached from a row in a directory, and the server cannot
 * tell a mis-click from an intention.
 *
 * It is also the second red button on this screen. Two per-person destructive actions on one card
 * that ask for different levels of confirmation is what actually trains somebody to click through
 * the cheaper one.
 *
 * **The consequences are listed before the field, not after.** Two of them cannot be found out
 * afterwards — every remaining recovery code is destroyed, every session is closed — and one of the
 * five exists to separate this button from the other one: the account keeps working. An
 * administrator who confuses the two ends somebody's employment when they meant to help them sign
 * in.
 *
 * **A refusal is rendered here rather than left to the global toast.** The dialog is
 * `aria-modal="true"`, so while it is open nothing outside it is in the accessibility tree a screen
 * reader is confined to; the mutation therefore declares its own `onError` and the toast stands
 * aside, which keeps this action to one signal (`rules/errors-and-toasts.mdc` §2–§3,
 * `rules/tanstack-query.mdc` §10). Nothing typed is cleared by a refusal.
 *
 * After a successful run the dialog stays open and shows the report, for the reason the offboarding
 * dialog does: closing on success would hide the one thing worth reading — including «this account
 * had no second factor», which is what a mis-aimed reset looks like.
 */
export function ResetMfaDialog({ opened, userId, email, onClose }: ResetMfaDialogProps) {
  const { t } = useTranslation();
  const reset = EmployeeService.EmployeeMutations.useResetUserMfa();
  const [typed, setTyped] = useState('');

  /**
   * Fail-closed: nothing to type back means the button never unlocks.
   *
   * Stated as a property of the comparison rather than of the field, because that is where the
   * defect was the last time this product wrote a confirmation like this one — the offboarding
   * dialog compared against `lastName`, which is empty on every personnel record nobody has filled
   * in, so an empty field satisfied it and the red button was armed on open.
   *
   * Trimmed and case-insensitive: the control is «did you mean this person», not a spelling test.
   * `toLowerCase`, deliberately not `toLocaleLowerCase`: under a Turkish or Azeri host locale the
   * latter folds `I` to `ı`, and a correctly typed address would never match — a confirmation that
   * cannot be satisfied is worse than none.
   */
  const expected = email.trim().toLowerCase();
  const confirmed = expected !== '' && typed.trim().toLowerCase() === expected;

  const failureKey = reset.error === null ? undefined : SharedApi.errorMessageKey(reset.error);

  const dismiss = (): void => {
    setTyped('');
    reset.reset();
    onClose();
  };

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it reaches
      // a screen reader as «button» — axe reports it as `button-name`.
      closeButtonProps={{ 'aria-label': t('security.reset.close') }}
      onClose={dismiss}
      opened={opened}
      title={t('security.reset.dialog.title')}
    >
      {reset.data === undefined ? (
        <Stack gap="md">
          <Text>{t('security.reset.dialog.description', { email })}</Text>

          <List size="sm">
            <List.Item>{t('security.reset.consequence.passwordOnly')}</List.Item>
            <List.Item>{t('security.reset.consequence.codes')}</List.Item>
            <List.Item>{t('security.reset.consequence.sessions')}</List.Item>
            <List.Item>{t('security.reset.consequence.notified')}</List.Item>
            <List.Item>{t('security.reset.consequence.accessKept')}</List.Item>
          </List>

          <TextInput
            description={t('security.reset.confirmHint', { email })}
            label={t('security.reset.confirmLabel')}
            onChange={(event) => {
              setTyped(event.currentTarget.value);
            }}
            value={typed}
          />

          {failureKey !== undefined && (
            // `role="alert"`, so it is announced rather than merely drawn: the operator's attention
            // is on the button they just pressed (`rules/a11y.mdc` §13). The text comes from the
            // `code`, never from `detail` — the technical half went to the log.
            <Alert
              color="danger"
              role="alert"
              title={t('security.reset.failed.title')}
              variant="light"
            >
              <Text size="sm">{t(failureKey)}</Text>
            </Alert>
          )}

          {/* Cancel first in the DOM: the safe choice is the one a keyboard reaches without aiming
              (`rules/a11y.mdc` §6). */}
          <Group justify="flex-end">
            <Button onClick={dismiss} variant="default">
              {t('security.reset.cancel')}
            </Button>
            <Button
              color="danger"
              disabled={!confirmed}
              loading={reset.isPending}
              onClick={() => {
                reset.mutate(userId);
              }}
            >
              {t('security.reset.submit')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          <ResetMfaReport result={reset.data} />
          <Group justify="flex-end">
            <Button onClick={dismiss} variant="default">
              {t('security.reset.close')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
