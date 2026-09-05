import { Button, Stack, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useForm } from '@mantine/form';

import { SharedLib } from '@shared';

import { firstInvalidField } from '@units/auth/lib';
import { forgotPasswordFormSchema, type ForgotPasswordFormValues } from '@units/auth/model';

import classes from './login-form.module.css';

export interface ForgotPasswordFormProps {
  /** Carried by the submit button, never by a page-wide spinner or a toast. */
  readonly isPending: boolean;
  readonly onSubmit: (values: ForgotPasswordFormValues) => void;
}

/**
 * One field, one button, and no knowledge of what happens next (`rules/frontend-fsd.mdc` rule 7).
 *
 * Whether the address belongs to an account is not decided here and is not decided anywhere the user
 * can see: `POST /auth/forgot-password` answers 202 either way. What this form decides is whether
 * what was typed is an address at all — the same `zodFormResolver` stack as the sign-in form
 * (ADR-0006 §4), so Mantine wires `aria-invalid` and the `aria-describedby` that points at the
 * message, and the message lands under the field rather than in a toast
 * (`rules/errors-and-toasts.mdc` §4).
 *
 * Focus moves to the field that failed. Without it a refused submit announces nothing and leaves the
 * caret where it was: a sighted user sees red, and nobody else learns anything happened.
 *
 * It shares the sign-in form's stylesheet because it is the same object — a single column of fields
 * at the same width, centred on a screen with nothing else on it. A second file with the same three
 * declarations is a second place for that width to drift (`rules/design-system.mdc`).
 */
export function ForgotPasswordForm({ isPending, onSubmit }: ForgotPasswordFormProps) {
  const { t } = useTranslation();

  const form = useForm<ForgotPasswordFormValues>({
    mode: 'uncontrolled',
    initialValues: { email: '' },
    // The resolver answers with an issue per field — an i18n **key** and the bound that refused
    // (`rules/i18n.mdc` §1), not a sentence. Without this step React is handed an object as a child
    // and the render throws; the form would not ship untranslated, it would not ship at all.
    validate: (values) =>
      SharedLib.translateFormIssues(SharedLib.zodFormResolver(forgotPasswordFormSchema)(values), t),
  });

  return (
    <form
      className={classes['root']}
      noValidate
      onSubmit={form.onSubmit(
        // Named parameter rather than `onSubmit` passed straight through: Mantine also hands the
        // submit event to the handler, and a prop typed «takes the address» must not quietly
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
        <TextInput
          autoComplete="email"
          key={form.key('email')}
          label={t('auth.forgotPassword.email.label')}
          required
          type="email"
          {...form.getInputProps('email')}
        />

        <Button fullWidth loading={isPending} type="submit">
          {t('auth.forgotPassword.submit')}
        </Button>
      </Stack>
    </form>
  );
}
