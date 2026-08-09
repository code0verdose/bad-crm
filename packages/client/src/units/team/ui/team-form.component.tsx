import { Button, Stack, TextInput, Textarea } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import {
  MAX_DESCRIPTION,
  MAX_NAME,
  MAX_SLUG,
  teamFormSchema,
  type TeamForm as TeamFormValues,
} from '@units/team/model';

export interface TeamFormProps {
  /** What the fields start as. Empty for a new team, the stored team for a rename. */
  readonly initialValues: TeamFormValues;
  readonly isPending: boolean;
  /** i18n key of the submit control — «Create» and «Save» are the same form, twice. */
  readonly submitLabelKey: string;
  readonly onSubmit: (values: TeamFormValues) => void;
}

/**
 * A team's three fields: markup, one handler, and no idea what happens next.
 *
 * One component for both writes, because both endpoints take the same whole `TeamDraft` — `PATCH`
 * replaces rather than merges, so a rename form that offered only the name would clear the
 * description of every team it saved.
 *
 * What is decided here is only whether the form is *well formed*, by the same bounds the contract
 * publishes. Whether the slug is free is `POST /teams`' answer — `409 team_already_exists` — and the
 * screen that owns the request shows it.
 *
 * `Textarea` for the description and `TextInput` for the rest: the description is prose that wraps,
 * and a single-line input for it would hide everything past the first sixty characters of a field
 * whose whole point is that somebody explains what the team is.
 */
export function TeamForm({ initialValues, isPending, submitLabelKey, onSubmit }: TeamFormProps) {
  const { t } = useTranslation();

  const form = useForm<TeamFormValues>({
    mode: 'uncontrolled',
    initialValues,
    validate: schemaResolver(teamFormSchema, { sync: true }),
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
          key={form.key('name')}
          label={t('teams.field.name')}
          maxLength={MAX_NAME}
          required
          {...form.getInputProps('name')}
        />

        <TextInput
          description={t('teams.field.slugHint')}
          key={form.key('slug')}
          label={t('teams.field.slug')}
          maxLength={MAX_SLUG}
          required
          {...form.getInputProps('slug')}
        />

        {/*
          `rows`, not `autosize`. Not a style preference: Mantine's `autosize` renders
          `react-textarea-autosize`, which measures a hidden clone with the layout engine — and jsdom
          has none, so every component test that mounts this form throws inside the textarea and is
          caught by the route's error boundary. Measured, not assumed: the whole create dialog
          rendered as «errors.route.failed» until this line changed. `rows` also scales with the font
          rather than pinning a height, which is what `rules/a11y.mdc` §4 asks for at 200 % text.
        */}
        <Textarea
          key={form.key('description')}
          label={t('teams.field.description')}
          maxLength={MAX_DESCRIPTION}
          rows={3}
          {...form.getInputProps('description')}
        />

        <Button loading={isPending} type="submit">
          {t(submitLabelKey)}
        </Button>
      </Stack>
    </form>
  );
}
