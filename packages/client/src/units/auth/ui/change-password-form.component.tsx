import { Alert, Button, PasswordInput, Stack, Text } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { firstInvalidField, type PasswordChangeFailure } from '@units/auth/lib';
import { changePasswordFormSchema, type ChangePasswordFormValues } from '@units/auth/model';

import { PasswordStrength } from './password-strength.component.js';

export interface ChangePasswordFormProps {
  readonly isPending: boolean;
  /** Where the last refusal belongs — under a field, or above all of them. */
  readonly failure: PasswordChangeFailure;
  /** Fires with all three values; dropping the confirmation is the hook's job, not this one's. */
  readonly onSubmit: (values: ChangePasswordFormValues, onChanged: () => void) => void;
}

const EMPTY: ChangePasswordFormValues = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

/**
 * The password one has, the password one wants, and that password again.
 *
 * **`mode: 'controlled'`, alone among the forms of this unit.** The others are uncontrolled because
 * nothing on screen depends on what is in them between submissions; here the strength meter does,
 * and a meter that only updated on blur would be a meter that is wrong while somebody is choosing a
 * password — which is the entire window it exists for.
 *
 * **Server refusals arrive as field errors, not as a toast.** `rules/errors-and-toasts.mdc` §4 is
 * explicit about it («серверные ошибки полей мапятся в `form.setErrors`»), and the reason is on
 * screen: three masked inputs, and a message in the corner saying «invalid credentials» does not say
 * which of them is the one that is wrong. The mapping itself is in `passwordChangeFailure`, one
 * layer down — a widget turning an `Error` into a key is the defect `useTotpDisposal` was extracted
 * to fix.
 *
 * **The one refusal that has no field goes above all three**, in a `role="alert"`: `429` is the
 * realistic case, because this operation shares its rate-limit counter with sign-in, so somebody who
 * has just mistyped their password a few times meets it here.
 *
 * **Success empties the form.** Three filled password fields after a successful change are three
 * copies of a live credential sitting in the DOM, and the second of them is no longer even true.
 */
export function ChangePasswordForm({ isPending, failure, onSubmit }: ChangePasswordFormProps) {
  const { t } = useTranslation();

  const form = useForm<ChangePasswordFormValues>({
    mode: 'controlled',
    initialValues: EMPTY,
    validate: schemaResolver(changePasswordFormSchema, { sync: true }),
  });

  const { fieldErrors } = failure;
  const { setErrors } = form;

  /**
   * The server's verdict, written onto the fields it is about.
   *
   * A genuine synchronisation with something outside this component — the mutation's error, owned by
   * the query cache — and the one job `useEffect` is still for (`rules/frontend-fsd.mdc` rule 11).
   * It cannot be done in the submit handler: the answer arrives long after that handler returned,
   * and it cannot be computed during render either, because `setErrors` is a write.
   */
  useEffect(() => {
    if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
  }, [fieldErrors, setErrors]);

  return (
    <form
      noValidate
      onSubmit={form.onSubmit(
        (values) => {
          onSubmit(values, () => {
            form.setValues(EMPTY);
            form.reset();
          });
        },
        (errors) => {
          form.getInputNode(firstInvalidField(errors))?.focus();
        },
      )}
    >
      <Stack gap="md">
        {failure.alertKey !== undefined && (
          // `role="alert"`, so it is announced rather than merely drawn: attention is on the button
          // that was just pressed (`rules/a11y.mdc` §13).
          <Alert
            color="danger"
            role="alert"
            title={t('security.password.failed.title')}
            variant="light"
          >
            <Text size="sm">{t(failure.alertKey)}</Text>
          </Alert>
        )}

        {/*
          `aria-invalid` by hand on every one of them: `PasswordInput` is a wrapper around an inner
          input, so Mantine's own attribute lands on the wrapper and leaves the control a screen
          reader reaches described by the error but not marked as the invalid one
          (`rules/a11y.mdc` §18).
        */}
        <PasswordInput
          aria-invalid={form.errors['currentPassword'] !== undefined}
          autoComplete="current-password"
          key={form.key('currentPassword')}
          label={t('security.password.current.label')}
          required
          {...form.getInputProps('currentPassword')}
        />

        <PasswordInput
          aria-invalid={form.errors['newPassword'] !== undefined}
          // `new-password` is what makes a manager offer to generate and store one. On this field it
          // also stops it offering the password being replaced.
          autoComplete="new-password"
          description={t('security.password.new.description')}
          key={form.key('newPassword')}
          label={t('security.password.new.label')}
          required
          {...form.getInputProps('newPassword')}
        />

        <PasswordStrength value={form.getValues().newPassword} />

        <PasswordInput
          aria-invalid={form.errors['confirmPassword'] !== undefined}
          autoComplete="new-password"
          key={form.key('confirmPassword')}
          label={t('security.password.confirm.label')}
          required
          {...form.getInputProps('confirmPassword')}
        />

        {/* The wait is on the control that started it, never on a page-wide spinner (§7). */}
        <Button loading={isPending} type="submit">
          {t('security.password.submit')}
        </Button>
      </Stack>
    </form>
  );
}
