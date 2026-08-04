import { Button, PasswordInput, Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { schemaResolver, useForm } from '@mantine/form';

import { firstInvalidField } from '@units/auth/lib';
import { resetPasswordFormSchema, type ResetPasswordFormValues } from '@units/auth/model';

import classes from './login-form.module.css';

export interface ResetPasswordFormProps {
  /** Carried by the submit button, never by a page-wide spinner or a toast. */
  readonly isPending: boolean;
  readonly onSubmit: (values: ResetPasswordFormValues) => void;
}

/**
 * Two masked fields and a button — and, conspicuously, no token.
 *
 * The token is in the path of the route that rendered this screen; the page reads it there and the
 * hook puts it in the request body. It is never a field, never a value, never anything this
 * component could render into the DOM by accident (`docs/security/threat-model.md`, T-IAM-07).
 *
 * `autoComplete="new-password"` on both, which is what stops a password manager offering the *old*
 * password on the screen whose whole purpose is to replace it, and what makes it offer to generate
 * and store a new one instead.
 *
 * The policy check and the equality check are both `resetPasswordFormSchema`, rendered by
 * `schemaResolver` under the field each belongs to — the equality failure is pointed at
 * `confirmPassword`, which is the field the person has to fix.
 *
 * It shares the sign-in form's stylesheet: same object, same width, one place for it to change.
 */
export function ResetPasswordForm({ isPending, onSubmit }: ResetPasswordFormProps) {
  const { t } = useTranslation();

  const form = useForm<ResetPasswordFormValues>({
    mode: 'uncontrolled',
    initialValues: { newPassword: '', confirmPassword: '' },
    validate: schemaResolver(resetPasswordFormSchema, { sync: true }),
  });

  return (
    <form
      className={classes['root']}
      noValidate
      onSubmit={form.onSubmit(
        // Named parameter rather than `onSubmit` passed straight through: Mantine also hands the
        // submit event to the handler, and a prop typed «takes the passwords» must not quietly
        // receive a second argument nobody declared.
        (values) => {
          onSubmit(values);
        },
        (errors) => {
          form.getInputNode(firstInvalidField(errors))?.focus();
        },
      )}
    >
      <Stack gap="md">
        {/*
          `aria-invalid` by hand, as on the sign-in form: `TextInput` puts it on the element the
          label points at, while a `PasswordInput` is a wrapper around an inner input and the
          attribute lands on the wrapper — leaving the control a screen reader reaches described by
          the error but not marked as the invalid one (`rules/a11y.mdc` §18).
        */}
        <PasswordInput
          aria-invalid={form.errors['newPassword'] !== undefined}
          autoComplete="new-password"
          key={form.key('newPassword')}
          label={t('auth.resetPassword.newPassword.label')}
          required
          {...form.getInputProps('newPassword')}
        />

        <PasswordInput
          aria-invalid={form.errors['confirmPassword'] !== undefined}
          autoComplete="new-password"
          key={form.key('confirmPassword')}
          label={t('auth.resetPassword.confirmPassword.label')}
          required
          {...form.getInputProps('confirmPassword')}
        />

        <Button fullWidth loading={isPending} type="submit">
          {t('auth.resetPassword.submit')}
        </Button>
      </Stack>
    </form>
  );
}
