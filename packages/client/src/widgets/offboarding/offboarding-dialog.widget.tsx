import { Alert, Button, List, Modal, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

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
  const offboarding = EmployeeService.EmployeeHooks.useOffboarding(userId);
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

  /** Closes with both fields and the last answer forgotten, so the next open starts from nothing. */
  const dismiss = (): void => {
    setTyped('');
    setReason('');
    offboarding.dismiss();
    onClose();
  };

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it reaches
      // a screen reader as «button» — axe reports it as `button-name`, and it was reporting it about
      // this dialog until the label was added. The same defect the pagination controls had.
      closeButtonProps={{ 'aria-label': t('offboarding.close') }}
      onClose={dismiss}
      opened={opened}
      title={t('offboarding.title')}
    >
      {offboarding.report === undefined ? (
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

          {offboarding.failureKey !== undefined && (
            // `role="alert"`, so it is announced rather than merely drawn: the operator's attention
            // is on the button they just pressed (`rules/a11y.mdc` §13). The refusal is rendered
            // here rather than toasted because this dialog is `aria-modal="true"` — a toast in the
            // corner is, for a screen-reader user, no signal at all — and it arrives from
            // `useOffboarding` already as a key, chosen from the `code` and never from `detail`.
            // Reading the `Error` here, which is what this dialog used to do, would apply that rule
            // on a second layer (`rules/frontend-fsd.mdc` rule 4, `rules/errors-and-toasts.mdc` §10).
            <Alert
              color="danger"
              role="alert"
              title={t('offboarding.failed.title')}
              variant="light"
            >
              <Text size="sm">{t(offboarding.failureKey)}</Text>
            </Alert>
          )}

          <Button
            color="danger"
            disabled={!confirmed || reason.trim() === ''}
            loading={offboarding.isPending}
            onClick={() => {
              offboarding.deactivate(reason);
            }}
          >
            {t('offboarding.submit')}
          </Button>
        </Stack>
      ) : (
        <Stack gap="md">
          <OffboardingReport report={offboarding.report} />
          <Button onClick={dismiss} variant="default">
            {t('offboarding.close')}
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
