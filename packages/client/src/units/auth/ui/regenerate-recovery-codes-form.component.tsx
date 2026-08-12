import { Alert, Button, PasswordInput, Stack, Text } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import { firstInvalidField } from '@units/auth/lib';
import {
  regenerateRecoveryCodesFormSchema,
  type RegenerateRecoveryCodesFormValues,
} from '@units/auth/model';

import { TotpCodeField } from './totp-code-field.component.js';

export interface RegenerateRecoveryCodesFormProps {
  readonly isPending: boolean;
  /** i18n key of the refusal — in practice always `reauthentication_required`. */
  readonly failureKey: string | undefined;
  readonly onSubmit: (values: RegenerateRecoveryCodesFormValues) => void;
}

/**
 * Replacing the set: the password and a live code, in one submission.
 *
 * Both proofs, because this button destroys ten credentials and mints ten more. It is also the
 * documented way back from a lost enrolment answer, which is why nothing here is hidden behind a
 * «danger zone» disclosure — somebody arriving from that failure has to be able to find it.
 *
 * The refusal is one code for three causes: wrong password, wrong TOTP code, and «this account has
 * no TOTP at all» all answer `403 reauthentication_required`, deliberately indistinguishable. So
 * the message sits above both fields rather than under either one — attaching it to a field would
 * claim knowledge the server refused to give.
 */
export function RegenerateRecoveryCodesForm({
  isPending,
  failureKey,
  onSubmit,
}: RegenerateRecoveryCodesFormProps) {
  const { t } = useTranslation();

  const form = useForm<RegenerateRecoveryCodesFormValues>({
    mode: 'uncontrolled',
    initialValues: { currentPassword: '', totpCode: '' },
    validate: schemaResolver(regenerateRecoveryCodesFormSchema, { sync: true }),
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
        {failureKey !== undefined && (
          <Alert
            color="red"
            role="alert"
            title={t('security.codes.regenerate.failed.title')}
            variant="light"
          >
            <Text size="sm">{t(failureKey)}</Text>
          </Alert>
        )}

        {/* The same hand-set `aria-invalid` as everywhere a `PasswordInput` carries an error. */}
        <PasswordInput
          aria-invalid={form.errors['currentPassword'] !== undefined}
          autoComplete="current-password"
          key={form.key('currentPassword')}
          label={t('security.codes.regenerate.password.label')}
          required
          {...form.getInputProps('currentPassword')}
        />

        <TotpCodeField
          key={form.key('totpCode')}
          label={t('security.codes.regenerate.code.label')}
          required
          {...form.getInputProps('totpCode')}
        />

        <Button color="red" loading={isPending} type="submit" variant="light">
          {t('security.codes.regenerate.submit')}
        </Button>
      </Stack>
    </form>
  );
}
