import { Button, Checkbox, Group, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import {
  REASON_MAX_LENGTH,
  permissionOverrideFormSchema,
  type PermissionOverrideFormValues,
} from '@units/iam/model';

export interface PermissionOverrideFormProps {
  /** Which way the exception points — it decides the wording, not the fields. */
  readonly effect: 'ALLOW' | 'DENY';
  /** The key being excepted, shown so the form can be read on its own. */
  readonly permission: string;
  readonly initialValues: PermissionOverrideFormValues;
  readonly isPending: boolean;
  readonly onSubmit: (values: PermissionOverrideFormValues) => void;
  readonly onCancel: () => void;
}

/**
 * The two questions that have to be answered before one person differs from their role: **why**, and
 * **until when**.
 *
 * Both are refusals rather than nudges, and the schema is where they live
 * (`permission-override.schema.ts`). What this component adds is that the answers are shown **at the
 * fields** — a mandatory reason reported as a toast leaves somebody looking for what to fix
 * (`rules/errors-and-toasts.mdc` §4).
 *
 * **The messages are translated here, and that is deliberate rather than incidental.** The schemas
 * of this repository carry i18n keys as their Zod messages (`rules/i18n.mdc` §5), and Mantine
 * renders whatever is in `form.errors` verbatim — so a plain `{...form.getInputProps(field)}` puts
 * the key itself under the input. The neighbouring forms spread it straight through; this one
 * resolves the key first, because a person told `permissions.field.reasonTooShort` has been told
 * nothing.
 *
 * The date is a native `type="date"` rather than `@mantine/dates`: one field does not justify
 * pulling a picker and its date library into the administration chunk, and the value the contract
 * wants is a day. The zone is named in the label instead of guessed — see `override-expiry.util.ts`
 * for why it is UTC.
 */
export function PermissionOverrideForm({
  effect,
  permission,
  initialValues,
  isPending,
  onSubmit,
  onCancel,
}: PermissionOverrideFormProps) {
  const { t } = useTranslation();

  /**
   * `controlled`, unlike every other form in this tree, and for one mechanical reason: the expiry
   * field is disabled by the checkbox beside it. In `uncontrolled` mode Mantine does not re-render
   * on a value change — that is the whole point of it — so `disabled` would be read once, at mount,
   * and ticking «until somebody removes it» would leave an editable date field beside a checkbox
   * saying there is no date. Two fields that talk to each other is the case the mode exists for.
   */
  const form = useForm<PermissionOverrideFormValues>({
    mode: 'controlled',
    initialValues,
    validate: schemaResolver(permissionOverrideFormSchema, { sync: true }),
  });

  const reasonError = form.errors['reason'];
  const expiryError = form.errors['expiresOn'];
  const neverExpires = form.getValues().neverExpires;

  return (
    <form
      noValidate
      onSubmit={form.onSubmit((values) => {
        onSubmit(values);
      })}
    >
      <Stack gap="md">
        <Text size="sm">
          {effect === 'ALLOW'
            ? t('permissions.form.allowIntro', { permission })
            : t('permissions.form.denyIntro', { permission })}
        </Text>

        {/* The spread comes first on both fields, so the translated `error` below it wins over the
            raw key `getInputProps` carries. Spread last — the order the neighbouring forms use —
            would put `permissions.field.reasonTooShort` under the input. */}
        <Textarea
          {...form.getInputProps('reason')}
          description={t('permissions.form.reasonHint')}
          error={typeof reasonError === 'string' ? t(reasonError) : reasonError}
          label={t('permissions.form.reasonLabel')}
          maxLength={REASON_MAX_LENGTH}
          required
          // `rows`, not `autosize`: Mantine's autosize measures a hidden clone with the layout
          // engine, and jsdom has none — every component test mounting this form would throw inside
          // the textarea. The same reason `team-form.component.tsx` states next door.
          rows={3}
        />

        <TextInput
          {...form.getInputProps('expiresOn')}
          description={t('permissions.form.expiresHint')}
          // Readable but not editable while «until somebody removes it» is ticked: the value stays
          // on screen, so unticking puts back what was there rather than an empty field.
          disabled={neverExpires}
          error={typeof expiryError === 'string' ? t(expiryError) : expiryError}
          label={t('permissions.form.expiresLabel')}
          type="date"
        />

        <Checkbox
          {...form.getInputProps('neverExpires', { type: 'checkbox' })}
          label={t('permissions.form.neverExpires')}
        />

        <Group justify="flex-end">
          <Button disabled={isPending} onClick={onCancel} type="button" variant="default">
            {t('permissions.form.cancel')}
          </Button>
          {/* Spread rather than `color={… : undefined}`: an ALLOW has no colour of its own, and
              under `exactOptionalPropertyTypes` «no colour» is not the same as `undefined`. */}
          <Button
            {...(effect === 'DENY' ? { color: 'red' } : {})}
            loading={isPending}
            type="submit"
          >
            {t('permissions.form.submit')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
