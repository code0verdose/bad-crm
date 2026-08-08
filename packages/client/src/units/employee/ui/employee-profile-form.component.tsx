import { Button, NativeSelect, Stack, TextInput } from '@mantine/core';
import { schemaResolver, useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import {
  employeeProfileFormSchema,
  EMPLOYMENT_TYPE_LABEL,
  EMPLOYMENT_TYPES,
  type EmployeeProfileFormValues,
  type EmployeeProfilePayload,
} from '@units/employee/model';

export interface EmployeeProfileFormProps {
  readonly initialValues: EmployeeProfileFormValues;
  /**
   * Whether this caller may edit the employment half. The server decides the same thing again — this
   * only keeps the fields from being offered and then refused (`ux-architecture.md`, «Клиентская
   * проверка — только подсказка»).
   */
  readonly canEditEmployment: boolean;
  /**
   * Whether the document carried the emergency contact at all.
   *
   * Not the same question as `canEditEmployment`: the contact is a **self-service** field — anybody
   * fills in their own — so it is enabled on one's own record without any capability. What it must
   * not be is enabled over a value the server did not send, because the field would then show empty
   * and saving it would overwrite the stored ciphertext with nothing. A caller with
   * `employee:update` and without `employee:view_personal_data` is exactly that case.
   */
  readonly carriesEmergencyContact: boolean;
  readonly isPending: boolean;
  readonly onSubmit: (values: EmployeeProfilePayload) => void;
}

/**
 * The personnel form: markup, one handler, and no idea what happens next.
 *
 * The employment fields are **disabled rather than hidden** for somebody who may not edit them. They
 * are facts about the person that they are allowed to read — the contract type is on their own
 * contract — and hiding a value somebody may see turns a permission boundary into a guessing game.
 * A field a caller may not *read* never reaches this component at all: the server leaves it out of
 * the document.
 */
export function EmployeeProfileForm({
  initialValues,
  canEditEmployment,
  carriesEmergencyContact,
  isPending,
  onSubmit,
}: EmployeeProfileFormProps) {
  const { t } = useTranslation();

  const form = useForm<EmployeeProfileFormValues>({
    mode: 'uncontrolled',
    initialValues,
    validate: schemaResolver(employeeProfileFormSchema, { sync: true }),
  });

  return (
    <form
      noValidate
      onSubmit={form.onSubmit((values) => {
        onSubmit(employeeProfileFormSchema.parse(values));
      })}
    >
      <Stack gap="md">
        <TextInput
          key={form.key('firstName')}
          label={t('employee.firstName')}
          required
          {...form.getInputProps('firstName')}
        />
        <TextInput
          key={form.key('lastName')}
          label={t('employee.lastName')}
          required
          {...form.getInputProps('lastName')}
        />

        <TextInput
          disabled={!canEditEmployment}
          key={form.key('jobTitle')}
          label={t('employee.jobTitle')}
          {...form.getInputProps('jobTitle')}
        />
        <TextInput
          disabled={!canEditEmployment}
          key={form.key('department')}
          label={t('employee.department')}
          {...form.getInputProps('department')}
        />

        <NativeSelect
          data={EMPLOYMENT_TYPES.map((type) => ({
            value: type,
            label: t(EMPLOYMENT_TYPE_LABEL[type]),
          }))}
          disabled={!canEditEmployment}
          key={form.key('employmentType')}
          label={t('employee.employmentTypeLabel')}
          {...form.getInputProps('employmentType')}
        />

        {/*
          A plain numeric `TextInput` rather than Mantine's `NumberInput`, and a comma-separated
          `TextInput` rather than `TagsInput` below: both of those pull `Combobox` and its popover
          into the first paint, and this screen is not worth 23 kB of the budget
          (`ux-architecture.md` → «Бюджет бандла»). The value is parsed here, where the form already
          owns the difference between what is typed and what is sent.
        */}
        <TextInput
          disabled={!canEditEmployment}
          description={t('employee.capacityHint')}
          inputMode="numeric"
          key={form.key('weeklyCapacityHours')}
          label={t('employee.capacity')}
          {...form.getInputProps('weeklyCapacityHours')}
        />

        <TextInput
          key={form.key('timezone')}
          label={t('employee.timezone')}
          {...form.getInputProps('timezone')}
        />

        <TextInput
          description={t('employee.skillsHint')}
          key={form.key('skills')}
          label={t('employee.skills')}
          {...form.getInputProps('skills')}
        />

        <TextInput
          description={t('employee.emergencyHint')}
          // Disabled when the server did not send it: an empty enabled field over a stored value is
          // a save away from erasing somebody's emergency contact.
          disabled={!carriesEmergencyContact}
          key={form.key('emergencyContact')}
          label={t('employee.emergencyContact')}
          {...form.getInputProps('emergencyContact')}
        />

        <Button loading={isPending} type="submit">
          {t('employee.save')}
        </Button>
      </Stack>
    </form>
  );
}
