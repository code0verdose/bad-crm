import { Alert, Button, Fieldset, NativeSelect, Stack, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import {
  translateFieldErrors,
  type ProjectCandidate,
  type ProjectColorOption,
  type ProjectFormFailure,
} from '@units/project/lib';
import {
  MAX_PROJECT_DESCRIPTION,
  MAX_PROJECT_KEY,
  MAX_PROJECT_NAME,
  PROJECT_VISIBILITIES,
  PROJECT_VISIBILITY_LABEL,
  projectEditFormSchema,
  projectFormSchema,
  type ProjectFormValues,
} from '@units/project/model';

export interface ProjectFormProps {
  /**
   * `create` asks for everything; `edit` shows the key read-only (it is the prefix of every task
   * number and never changes) and leaves the visibility out — that is its own decision, with its own
   * confirmation, in its own section.
   */
  readonly mode: 'create' | 'edit';
  readonly initialValues: ProjectFormValues;
  /** Who can lead it — the directory, or only the people the reader may be told about. */
  readonly leadOptions: readonly ProjectCandidate[];
  readonly colorOptions: readonly ProjectColorOption[];
  /** The server's refusal: under the field it is about, or above the form. */
  readonly failure: ProjectFormFailure;
  readonly isPending: boolean;
  /** Archived: every field readable, nothing submittable — the banner above says why. */
  readonly disabled?: boolean;
  /** i18n key of the submit control — «Create project» and «Save» are this form, twice. */
  readonly submitLabelKey: string;
  readonly onSubmit: (values: ProjectFormValues) => void;
}

/**
 * A project's fields: markup, one handler, and no idea what happens next (`rules/frontend-fsd.mdc`
 * rule 7).
 *
 * `@mantine/form` with the shared `zodFormResolver` (ADR-0006 §4, `rules/zod-validation.mdc` §12):
 * the schema is the source of truth and its issues become the `error` of the field they belong to,
 * which is what wires `aria-invalid` and `aria-describedby` (`rules/a11y.mdc` §18).
 *
 * **The server's verdicts join the same slots.** A taken key, a lead that is no longer a live
 * account, a bound the server holds — each is rendered under its field, after the form's own issue
 * (a value the form refuses has to be fixed before the server's verdict on it could be true).
 * Everything else is one `Alert role="alert"` above the fields. Exactly one of the two is set for a
 * submit, so an action has one signal (`rules/errors-and-toasts.mdc` §2, §4).
 *
 * Native controls for the three choices: the lists are short, a phone renders its own picker for a
 * native select and a screen reader already knows it, and `type="date"` is the one date field the
 * product has (`units/iam/ui/permission-override-form.component.tsx` gives the same reasons).
 */
export function ProjectForm({
  mode,
  initialValues,
  leadOptions,
  colorOptions,
  failure,
  isPending,
  disabled = false,
  submitLabelKey,
  onSubmit,
}: ProjectFormProps) {
  const { t } = useTranslation();
  const schema = mode === 'create' ? projectFormSchema : projectEditFormSchema;
  const server = translateFieldErrors(failure.fields, t);

  const form = useForm<ProjectFormValues>({
    mode: 'uncontrolled',
    initialValues,
    // The resolver answers with an i18n key and the bound that refused, not a sentence.
    validate: (values) =>
      SharedLib.translateFormIssues(SharedLib.zodFormResolver(schema)(values), t),
  });

  return (
    <form
      noValidate
      onSubmit={form.onSubmit((values) => {
        onSubmit(values);
      })}
    >
      <Fieldset disabled={disabled} variant="unstyled">
        <Stack gap="md">
          {failure.notice !== undefined && (
            <Alert
              color="warning"
              role="alert"
              title={t(failure.notice.key, failure.notice.values ?? {})}
              variant="light"
            />
          )}

          <TextInput
            key={form.key('key')}
            autoComplete="off"
            description={t(
              mode === 'create' ? 'projects.field.keyHint' : 'projects.field.keyFixed',
            )}
            label={t('projects.field.key')}
            maxLength={MAX_PROJECT_KEY}
            readOnly={mode === 'edit'}
            required={mode === 'create'}
            {...form.getInputProps('key')}
            error={form.errors['key'] ?? server.key}
          />

          <TextInput
            key={form.key('name')}
            label={t('projects.field.name')}
            maxLength={MAX_PROJECT_NAME}
            required
            {...form.getInputProps('name')}
            error={form.errors['name'] ?? server.name}
          />

          {/* `rows`, not `autosize`: jsdom has no layout engine to measure a hidden clone with —
              the reason `team-form.component.tsx` records. */}
          <Textarea
            key={form.key('description')}
            label={t('projects.field.description')}
            maxLength={MAX_PROJECT_DESCRIPTION}
            rows={3}
            {...form.getInputProps('description')}
            error={form.errors['description'] ?? server.description}
          />

          {mode === 'create' && (
            <NativeSelect
              key={form.key('visibility')}
              data={PROJECT_VISIBILITIES.map((value) => ({
                value,
                label: t(PROJECT_VISIBILITY_LABEL[value]),
              }))}
              description={t('projects.field.visibilityHint')}
              label={t('projects.field.visibility')}
              {...form.getInputProps('visibility')}
              error={form.errors['visibility'] ?? server.visibility}
            />
          )}

          <NativeSelect
            key={form.key('leadId')}
            data={[{ value: '', label: t('projects.field.leadChoose') }, ...leadOptions]}
            description={t('projects.field.leadHint')}
            label={t('projects.field.lead')}
            required
            {...form.getInputProps('leadId')}
            error={form.errors['leadId'] ?? server.leadId}
          />

          <NativeSelect
            key={form.key('color')}
            data={colorOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey, option.values ?? {}),
            }))}
            description={t('projects.field.colorHint')}
            label={t('projects.field.color')}
            {...form.getInputProps('color')}
            error={form.errors['color'] ?? server.color}
          />

          <TextInput
            key={form.key('startedAt')}
            label={t('projects.field.startedAt')}
            type="date"
            {...form.getInputProps('startedAt')}
            error={form.errors['startedAt'] ?? server.startedAt}
          />

          <TextInput
            key={form.key('dueAt')}
            description={t('projects.field.datesHint')}
            label={t('projects.field.dueAt')}
            type="date"
            {...form.getInputProps('dueAt')}
            error={form.errors['dueAt'] ?? server.dueAt}
          />

          <Button loading={isPending} type="submit">
            {t(submitLabelKey)}
          </Button>
        </Stack>
      </Fieldset>
    </form>
  );
}
