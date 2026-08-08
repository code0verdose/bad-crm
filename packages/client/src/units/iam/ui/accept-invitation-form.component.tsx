import { Button, PasswordInput, Stack } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import { acceptInvitationFormSchema, type AcceptInvitationFormValues } from '@units/iam/model';

export interface AcceptInvitationFormProps {
  /** The language the interface is in — the account starts in it. */
  readonly defaultLocale: AcceptInvitationFormValues['locale'];
  /** Carried by the submit button, never by a page-wide spinner or a toast. */
  readonly isPending: boolean;
  readonly onSubmit: (values: AcceptInvitationFormValues) => void;
}

/**
 * The form the invited person fills in: two password fields and nothing else.
 *
 * **No address field**, and its absence is the security property rather than a simplification — the
 * account is created on the address stored on the invitation, and a form that asked would be asking
 * a question whose answer the server refuses to read.
 *
 * `aria-invalid` is set by hand on both fields: Mantine puts the attribute on the element the label
 * points at, and a `PasswordInput` is a wrapper around an inner input plus a visibility toggle, so
 * the attribute lands on the wrapper. Without this the control a screen reader lands on has the
 * `aria-describedby` to the message but nothing saying it is the invalid one (`rules/a11y.mdc` §18).
 */
export function AcceptInvitationForm({
  defaultLocale,
  isPending,
  onSubmit,
}: AcceptInvitationFormProps) {
  const { t } = useTranslation();

  const form = useForm<AcceptInvitationFormValues>({
    mode: 'uncontrolled',
    initialValues: { password: '', confirmPassword: '', locale: defaultLocale },
    validate: schemaResolver(acceptInvitationFormSchema, { sync: true }),
  });

  return (
    <form
      noValidate
      onSubmit={form.onSubmit((values) => {
        onSubmit(values);
      })}
    >
      <Stack gap="md">
        <PasswordInput
          aria-invalid={form.errors['password'] !== undefined}
          autoComplete="new-password"
          key={form.key('password')}
          label={t('members.accept.passwordLabel')}
          required
          {...form.getInputProps('password')}
        />

        <PasswordInput
          aria-invalid={form.errors['confirmPassword'] !== undefined}
          autoComplete="new-password"
          key={form.key('confirmPassword')}
          label={t('members.accept.confirmLabel')}
          required
          {...form.getInputProps('confirmPassword')}
        />

        <Button fullWidth loading={isPending} type="submit">
          {t('members.accept.submit')}
        </Button>
      </Stack>
    </form>
  );
}
