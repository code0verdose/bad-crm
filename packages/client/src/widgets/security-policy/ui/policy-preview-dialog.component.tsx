import { Alert, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi, type SharedApi } from '@shared';

import { OrganizationService } from '@units/organization';

/**
 * The colour of the button once the server has asked for the second signal.
 *
 * A constant rather than an inline literal: `i18next/no-literal-string` reads every string in JSX and
 * cannot tell a token from a sentence, and silencing it per line is how a real hardcoded sentence
 * eventually gets silenced too.
 */
const DANGER = { color: 'danger' } as const;

export interface PolicyPreviewDialogProps {
  readonly opened: boolean;
  readonly draft: OrganizationService.OrganizationHooks.PolicyDraft;
  readonly isDirty: boolean;
  readonly isSaving: boolean;
  /** The server asked for a second confirmation because the caller is covering themselves. */
  readonly needsSelfLockoutConfirmation: boolean;
  readonly failure: SharedApi.ErrorMessage | undefined;
  readonly onApply: () => void;
  readonly onClose: () => void;
}

/**
 * «Who will this affect», between drafting a policy and applying it (acceptance 2).
 *
 * **The numbers come from the server, computed against this exact draft.** The screen behind the
 * dialog already holds a coverage report — of the policy in force — and reusing it here would be the
 * defect this dialog exists to prevent: a confirmation naming the people yesterday's policy covers
 * while the button applies today's. `useMfaCoveragePreview` asks
 * `GET /organization/mfa-coverage?role=…&graceDays=…`, which runs the same verdict function the
 * sign-in gate runs.
 *
 * **The refusal is rendered here rather than left to the global toast.** The dialog is
 * `aria-modal="true"`, so while it is open nothing outside it is in the accessibility tree a screen
 * reader is confined to; the mutation therefore declares its own `onError` and the toast stands
 * aside, which keeps this action to one signal (`rules/errors-and-toasts.mdc` §2–§3).
 *
 * **The self-lockout warning is not a failure and is not drawn as one.** A 428 is the server asking
 * for a second signal before somebody puts themselves under a requirement they do not meet; the
 * alert is `warning`, the button changes its words, and nothing red appears for a decision that is
 * still being made (acceptance 7).
 *
 * **Cancel comes first in the DOM**, so the safe choice is the one a keyboard reaches without
 * aiming (`rules/a11y.mdc` §6). Mantine's `Modal` traps the focus and returns it to the trigger; the
 * trigger stays enabled through every outcome of this dialog, which is what makes that return land
 * somewhere.
 */
export function PolicyPreviewDialog({
  opened,
  draft,
  isDirty,
  isSaving,
  needsSelfLockoutConfirmation,
  failure,
  onApply,
  onClose,
}: PolicyPreviewDialogProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const preview = OrganizationService.OrganizationHooks.useMfaCoveragePreview(draft, opened);

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it
      // reaches a screen reader as «button» — axe reports it as `button-name`.
      closeButtonProps={{ 'aria-label': t('organization.security.preview.close') }}
      /*
        Not abandonable while the save is in flight, and the three of them together rather than one:
        Escape, a click outside and the cross are three ways to the same place. The refusal is
        rendered **here** rather than as a toast (`aria-modal` puts a toast outside the tree a screen
        reader is confined to), so a dialog that can vanish mid-request is a refusal nobody is ever
        told about — while the success of the very same request still speaks. One signal per action
        means one signal in either direction (`rules/errors-and-toasts.mdc` §2).
      */
      closeOnClickOutside={!isSaving}
      closeOnEscape={!isSaving}
      onClose={onClose}
      opened={opened}
      title={t('organization.security.preview.title')}
      withCloseButton={!isSaving}
    >
      <Stack gap="md">
        <Text size="sm">{t('organization.security.preview.description')}</Text>

        <SharedUi.DataState
          errorMessageKey="organization.security.preview.loadFailed"
          onRetry={preview.refetch}
          skeleton={<SharedUi.TextSkeleton lines={3} />}
          status={preview.status}
        >
          <Stack gap="xs">
            <Text fw={600}>
              {t('organization.security.preview.covered', { count: preview.covered })}
            </Text>
            <Text size="sm">
              {t('organization.security.preview.enrolled', {
                enrolled: preview.enrolled,
                missing: preview.covered - preview.enrolled,
              })}
            </Text>

            {preview.missing.length === 0 ? (
              <Text size="sm">{t('organization.security.preview.empty')}</Text>
            ) : (
              <>
                <Text fw={600} size="sm">
                  {t('organization.security.preview.listTitle')}
                </Text>
                <List size="sm">
                  {preview.missing.map((row) => (
                    <List.Item key={row.userId}>{row.email}</List.Item>
                  ))}
                </List>
              </>
            )}
          </Stack>
        </SharedUi.DataState>

        {needsSelfLockoutConfirmation && (
          // `role="alert"`: the operator's attention is on the button they have just pressed, and
          // this appeared in answer to it (`rules/a11y.mdc` §13).
          <Alert
            color="warning"
            role="alert"
            title={t('organization.security.preview.selfLockout.title')}
            variant="light"
          >
            <Text size="sm">{t('organization.security.preview.selfLockout.body')}</Text>
          </Alert>
        )}

        {failure !== undefined && (
          <Alert
            color="danger"
            role="alert"
            title={t('organization.security.preview.failed.title')}
            variant="light"
          >
            <Text size="sm">{t(failure.key, failure.values ?? {})}</Text>
          </Alert>
        )}

        {!isDirty && (
          <Text c="var(--bc-text-muted)" id={hintId} size="sm">
            {t('organization.security.preview.nothingToApply')}
          </Text>
        )}

        <Group justify="flex-end">
          <Button disabled={isSaving} onClick={onClose} variant="default">
            {t('organization.security.preview.cancel')}
          </Button>
          <Button
            // Spread rather than `color={… : undefined}`: `exactOptionalPropertyTypes` makes an
            // explicit `undefined` a different thing from an absent prop.
            {...(needsSelfLockoutConfirmation ? DANGER : {})}
            /*
              `aria-disabled` and `data-disabled`, never the hard `disabled` (`rules/a11y.mdc` §23).
              Nothing to apply when the draft says what is already stored — the write is a `CRITICAL`
              audit entry, and one recording no change is noise in the record somebody reads during an
              incident — but this dialog is also opened just to look at the report, and a hard
              `disabled` takes the button out of the tab order entirely: a keyboard user then has no
              way to find out that the control exists or why it will not act. It stays reachable, and
              the sentence below says what it is waiting for.
            */
            {...(isDirty ? {} : { 'aria-describedby': hintId, 'data-disabled': true })}
            aria-disabled={!isDirty}
            // On the button that acts, never a spinner over the page (`rules/errors-and-toasts.mdc` §3).
            loading={isSaving}
            onClick={isDirty ? onApply : undefined}
          >
            {needsSelfLockoutConfirmation
              ? t('organization.security.preview.selfLockout.confirm')
              : t('organization.security.preview.apply')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
