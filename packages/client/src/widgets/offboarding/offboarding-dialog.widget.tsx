import { Alert, Button, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedApi } from '@shared';

import { EmployeeService } from '@units/employee';

import { OffboardingReport } from './ui/offboarding-report.component.js';

export interface OffboardingDialogProps {
  readonly opened: boolean;
  readonly userId: string;
  /**
   * Typed back by the administrator to confirm. The **email address** of the person being switched
   * off — see the note on the confirmation below for why it is not their surname.
   */
  readonly email: string;
  readonly onClose: () => void;
}

/**
 * Switching a colleague off, behind a confirmation that cannot be clicked through.
 *
 * **The address has to be typed.** Not decoration and not distrust: this is the one screen in the
 * product whose button ends somebody's access to everything at once, and it is reached from a row in
 * a list of people — a mis-click away from the wrong person. Typing the identifier back is the
 * cheapest control that makes «which row was I on» impossible to get wrong.
 *
 * **The consequences are listed before the button, not after.** An administrator should be able to
 * decide from this dialog rather than from the report, and «teams are left and not restored» is the
 * part people are surprised by later.
 *
 * After a successful run the dialog stays open and shows the report: closing on success would hide
 * the one thing worth reading, including the steps this installation could not take.
 */
export function OffboardingDialog({ opened, userId, email, onClose }: OffboardingDialogProps) {
  const { t } = useTranslation();
  const deactivate = EmployeeService.EmployeeMutations.useDeactivateUser();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');

  /**
   * The email address, and **not** the surname it used to be.
   *
   * `lastName` defaults to an empty string: the repository answers with an empty personnel row when
   * no `EmployeeProfile` exists, and neither registration nor accepting an invitation creates one.
   * So on the majority of records the confirmation was comparing against `''` — satisfied by an
   * empty field, the red button armed on open, the hint reading «Введите „“». The address is on the
   * same document, is unique, is never empty, and is shown right here in the hint.
   *
   * **Fail-closed**: nothing to type back means the button never unlocks. The alternative — what the
   * comparison did before — is the barrier disappearing exactly on the records nobody has filled in.
   *
   * Trimmed and case-insensitive: the control is «did you mean this person», not a spelling test.
   * `toLowerCase`, deliberately not `toLocaleLowerCase`: under a Turkish or Azeri host locale the
   * latter folds `I` to `ı`, and a correctly typed «Ivanov» would never match — a confirmation that
   * cannot be satisfied is worse than none.
   */
  const expected = email.trim().toLowerCase();
  const confirmed = expected !== '' && typed.trim().toLowerCase() === expected;

  /**
   * The refusal, as the sentence its `code` maps to — rendered inside the dialog rather than left
   * to the global toast.
   *
   * The dialog is `aria-modal="true"`, so while it is open nothing outside it is in the
   * accessibility tree: a toast in the corner is, for a screen-reader user, no signal at all. The
   * mutation therefore declares its own `onError` and the toast stands aside, which keeps this one
   * action to one signal (`rules/errors-and-toasts.mdc` §2–§3, `rules/tanstack-query.mdc` §10).
   */
  const failureKey =
    deactivate.error === null ? undefined : SharedApi.errorMessageKey(deactivate.error);

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it reaches
      // a screen reader as «button» — axe reports it as `button-name`, and it was reporting it about
      // this dialog until the label was added. The same defect the pagination controls had.
      closeButtonProps={{ 'aria-label': t('offboarding.close') }}
      onClose={() => {
        setTyped('');
        setReason('');
        deactivate.reset();
        onClose();
      }}
      opened={opened}
      title={t('offboarding.title')}
    >
      {deactivate.data === undefined ? (
        <Stack gap="md">
          <Text>{t('offboarding.description')}</Text>
          <List size="sm">
            <List.Item>{t('offboarding.consequence.sessions')}</List.Item>
            <List.Item>{t('offboarding.consequence.teams')}</List.Item>
            <List.Item>{t('offboarding.consequence.data')}</List.Item>
            <List.Item>{t('offboarding.consequence.reactivation')}</List.Item>
          </List>

          <TextInput
            label={t('offboarding.reasonLabel')}
            maxLength={500}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
            required
            value={reason}
          />
          <TextInput
            description={t('offboarding.confirmHint', { email })}
            label={t('offboarding.confirmLabel')}
            onChange={(event) => {
              setTyped(event.currentTarget.value);
            }}
            value={typed}
          />

          {failureKey !== undefined && (
            // `role="alert"`, so it is announced rather than merely drawn: the operator's attention
            // is on the button they just pressed (`rules/a11y.mdc` §13). The text comes from the
            // `code`, never from `detail` — the technical half went to the log.
            <Alert color="red" role="alert" title={t('offboarding.failed.title')} variant="light">
              <Text size="sm">{t(failureKey)}</Text>
            </Alert>
          )}

          <Button
            color="red"
            disabled={!confirmed || reason.trim() === ''}
            loading={deactivate.isPending}
            onClick={() => {
              deactivate.mutate({ userId, reason: reason.trim() });
            }}
          >
            {t('offboarding.submit')}
          </Button>
        </Stack>
      ) : (
        <Stack gap="md">
          <OffboardingReport report={deactivate.data} />
          <Button
            onClick={() => {
              setTyped('');
              setReason('');
              deactivate.reset();
              onClose();
            }}
            variant="default"
          >
            {t('offboarding.close')}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
