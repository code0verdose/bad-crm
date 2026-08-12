import { Alert, Button, Group, PasswordInput, Stack, Text } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import { firstInvalidField } from '@units/auth/lib';
import { totpConfirmFormSchema, type TotpConfirmFormValues } from '@units/auth/model';

import { TotpCodeField } from './totp-code-field.component.js';

export interface TotpConfirmFormProps {
  readonly isPending: boolean;
  /** i18n key of the refusal, chosen from the problem `code` by the unit hook. */
  readonly failureKey: string | undefined;
  readonly onSubmit: (values: TotpConfirmFormValues) => void;
  /** Abandons the drafted secret. «Not now», not «try again». */
  readonly onCancel: () => void;
}

/**
 * The last step of enrolment: the code from the authenticator and the account's own password.
 *
 * The form stack is the product's one form stack — `@mantine/form` with the built-in
 * `schemaResolver`, so the schema decides what is well-formed and Mantine wires `aria-invalid` and
 * `aria-describedby` to the message (`rules/design-system.mdc` §11, `rules/a11y.mdc` §18). Whether
 * the *values* are right is decided by the server, and its refusal arrives as `failureKey`.
 *
 * **The refusal is rendered here, beside the fields, rather than as a toast** — and it carries a
 * second sentence the contract asks every client to carry. `POST /auth/2fa/confirm` answers the
 * ten recovery codes exactly once; if that answer is lost in transit, 2FA is on, the codes were
 * never seen, and a retry answers `422 invalid_totp_code` because the draft is gone. Somebody in
 * that position is looking at a screen that says «wrong code» about a code that was right. The way
 * out exists — reissue the set with the password and a live code, both of which they have — and the
 * only thing standing between them and it is being told. So they are told, here, at the moment it
 * happens.
 */
export function TotpConfirmForm({
  isPending,
  failureKey,
  onSubmit,
  onCancel,
}: TotpConfirmFormProps) {
  const { t } = useTranslation();

  const form = useForm<TotpConfirmFormValues>({
    mode: 'uncontrolled',
    initialValues: { code: '', currentPassword: '' },
    validate: schemaResolver(totpConfirmFormSchema, { sync: true }),
  });

  return (
    <form
      noValidate
      onSubmit={form.onSubmit(
        (values) => {
          onSubmit(values);
        },
        (errors) => {
          form.getInputNode(firstInvalidField(errors))?.focus();
        },
      )}
    >
      <Stack gap="md">
        <TotpCodeField
          description={t('security.totp.code.description')}
          key={form.key('code')}
          label={t('security.totp.code.label')}
          required
          {...form.getInputProps('code')}
        />

        {/*
          `aria-invalid` by hand, and only here: Mantine puts the attribute on the element the label
          points at, and a `PasswordInput` is a wrapper whose inner input is what a reader lands on.
          The same fix, for the same reason, as on the sign-in form.
        */}
        <PasswordInput
          aria-invalid={form.errors['currentPassword'] !== undefined}
          autoComplete="current-password"
          description={t('security.totp.password.description')}
          key={form.key('currentPassword')}
          label={t('security.totp.password.label')}
          required
          {...form.getInputProps('currentPassword')}
        />

        {failureKey !== undefined && (
          <Alert color="red" role="alert" title={t('security.totp.failed.title')} variant="light">
            <Stack gap="xs">
              <Text size="sm">{t(failureKey)}</Text>
              <Text size="sm">{t('security.totp.failed.lostAnswer')}</Text>
            </Stack>
          </Alert>
        )}

        <Group gap="sm">
          <Button loading={isPending} type="submit">
            {t('security.totp.confirm')}
          </Button>
          <Button onClick={onCancel} type="button" variant="default">
            {t('security.totp.cancel')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
