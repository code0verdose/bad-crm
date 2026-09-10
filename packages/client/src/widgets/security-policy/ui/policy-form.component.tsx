import { Button, Checkbox, Group, NumberInput, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { SharedOrganization } from '@bad-crm/shared';
import { useTranslation } from 'react-i18next';

import { OrganizationModel, OrganizationService, type OrganizationApi } from '@units/organization';

import { PolicyPreviewDialog } from './policy-preview-dialog.component.js';

export interface PolicyFormProps {
  /** The policy as stored. The draft is seeded from it once and then belongs to the editor. */
  readonly policy: OrganizationApi.SecurityPolicy;
}

/**
 * Drafting the organization's second-factor policy: which roles, and how long they have.
 *
 * **Nothing here saves.** The form edits a draft and opens the confirmation; applying happens inside
 * the dialog, after the server has said who it will affect. That ordering is acceptance 2 and it is
 * the reason the trigger reads «Review who this affects» rather than «Save».
 *
 * **The trigger is never disabled**, including after a successful save. Mantine returns the focus to
 * the control a modal was opened from, and a control disabled by the same state change that closed
 * the dialog receives that focus into nothing — the defect
 * `test/architecture/modal-focus-coverage.test.ts` exists because of. What is disabled instead is
 * the *apply* button inside the dialog, which nobody's focus is returned to.
 *
 * **The role picker offers the seven system roles.** A policy may also name a custom role by id, and
 * one that does keeps it — `draft.roles` is sent back whole — but this screen cannot show such a
 * role by name without `GET /roles` and a second permission. The count is stated rather than hidden,
 * so nobody reads the checkboxes as the entire policy.
 */
export function PolicyForm({ policy }: PolicyFormProps) {
  const { t } = useTranslation();
  const [opened, { open, close }] = useDisclosure(false);
  const editor = OrganizationService.OrganizationHooks.useSecurityPolicyEditor(policy, close);

  return (
    <Stack gap="md">
      <Checkbox.Group
        description={t('organization.security.rolesHint')}
        label={t('organization.security.rolesLabel')}
        value={[...editor.draft.roles]}
      >
        <Stack gap="xs" mt="xs">
          {OrganizationModel.POLICY_ROLE_KEYS.map((role) => (
            <Checkbox
              key={role}
              label={t(OrganizationModel.POLICY_ROLE_LABEL[role])}
              onChange={() => {
                editor.toggleRole(role);
              }}
              value={role}
            />
          ))}
        </Stack>
      </Checkbox.Group>

      {editor.customRoles.length > 0 && (
        <Text c="var(--bc-text-muted)" size="sm">
          {t('organization.security.customRoles', { count: editor.customRoles.length })}
        </Text>
      )}

      <NumberInput
        allowDecimal={false}
        clampBehavior="strict"
        description={t('organization.security.graceHint')}
        label={t('organization.security.graceLabel')}
        max={SharedOrganization.MFA_GRACE_PERIOD_DAYS_MAX}
        min={0}
        onChange={(value) => {
          // Mantine reports an empty field as `''`; zero is the honest reading of «no grace period»
          // and is also what the schema's minimum is, so there is no third state to represent.
          editor.setGraceDays(typeof value === 'number' ? value : 0);
        }}
        value={editor.draft.graceDays}
        w={200}
      />

      <Text size="sm">
        {editor.draft.roles.length === 0
          ? t('organization.security.off')
          : t('organization.security.on', { count: editor.draft.roles.length })}
      </Text>

      <Group>
        <Button onClick={open}>{t('organization.security.review')}</Button>
        {editor.isDirty && (
          <Button onClick={editor.discard} variant="default">
            {t('organization.security.discard')}
          </Button>
        )}
      </Group>

      <PolicyPreviewDialog
        draft={editor.draft}
        failure={editor.failure}
        isDirty={editor.isDirty}
        isSaving={editor.isSaving}
        needsSelfLockoutConfirmation={editor.needsSelfLockoutConfirmation}
        onApply={editor.save}
        onClose={close}
        opened={opened}
      />
    </Stack>
  );
}
