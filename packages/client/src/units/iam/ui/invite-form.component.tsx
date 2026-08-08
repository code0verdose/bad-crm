import { Button, NativeSelect, Stack, TextInput } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import {
  INVITATION_LOCALE_LABEL,
  INVITATION_LOCALES,
  invitationFormSchema,
  type InvitationForm,
} from '@units/iam/model';

export interface InviteFormProps {
  /** Roles the caller may choose from. Empty when they cannot read roles — see the widget. */
  readonly roles: readonly { readonly value: string; readonly label: string }[];
  /** The language the interface is in, which is the best guess for a colleague at the same company. */
  readonly defaultLocale: InvitationForm['locale'];
  readonly isPending: boolean;
  readonly onSubmit: (values: InvitationForm) => void;
}

/**
 * The invite form: markup, one handler, and no idea what happens next.
 *
 * Whether the address may be invited at all — an account that already exists, an open invitation, a
 * role beyond what the inviter holds — is decided by `POST /invitations`. What is decided here is
 * only whether the form is *well formed*, by the same schema the server parses the body with.
 *
 * The role select offers «no role for now» as a real choice rather than leaving the field empty:
 * an invitation without a role is a legitimate thing to send, and a person who leaves a required
 * field blank should not have to guess whether that is what they just did.
 */
export function InviteForm({ roles, defaultLocale, isPending, onSubmit }: InviteFormProps) {
  const { t } = useTranslation();

  const form = useForm<InvitationForm>({
    mode: 'uncontrolled',
    initialValues: { email: '', roleId: '', locale: defaultLocale },
    validate: schemaResolver(invitationFormSchema, { sync: true }),
  });

  return (
    <form
      noValidate
      onSubmit={form.onSubmit((values) => {
        onSubmit(values);
      })}
    >
      <Stack gap="md">
        <TextInput
          autoComplete="email"
          key={form.key('email')}
          label={t('members.invite.emailLabel')}
          placeholder={t('members.invite.emailPlaceholder')}
          required
          type="email"
          {...form.getInputProps('email')}
        />

        {/*
          `NativeSelect`, not `Select`: the list is short and needs no search, and the native control
          is the one a phone renders as its own picker and a screen reader already knows. It is also
          the cheap one — Mantine's `Select` pulls `Combobox` and its popover into the bundle, which
          this screen would be paying for on every first paint (`ux-architecture.md` → «Бюджет
          бандла»).
        */}
        <NativeSelect
          data={[{ value: '', label: t('members.invite.roleNone') }, ...roles]}
          description={t('members.invite.roleHint')}
          key={form.key('roleId')}
          label={t('members.invite.roleLabel')}
          {...form.getInputProps('roleId')}
        />

        <NativeSelect
          data={INVITATION_LOCALES.map((locale) => ({
            value: locale,
            label: t(INVITATION_LOCALE_LABEL[locale]),
          }))}
          description={t('members.invite.localeHint')}
          key={form.key('locale')}
          label={t('members.invite.localeLabel')}
          {...form.getInputProps('locale')}
        />

        <Button loading={isPending} type="submit">
          {t('members.invite.submit')}
        </Button>
      </Stack>
    </form>
  );
}
