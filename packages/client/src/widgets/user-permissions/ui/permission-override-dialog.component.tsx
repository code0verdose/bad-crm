import { Alert, Modal, Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { IamLib, IamUi, type IamModel, type IamService } from '@units/iam';

export interface PermissionOverrideDialogProps {
  /** What is being written, or `null` when nothing is. */
  readonly draft: IamService.IamHooks.OverrideDraft | null;
  readonly isSaving: boolean;
  /** The last refusal, shown here rather than as a toast — see below. */
  readonly error: unknown;
  readonly onSubmit: (
    draft: IamService.IamHooks.OverrideDraft,
    values: IamModel.PermissionOverrideFormValues,
  ) => void;
  readonly onClose: () => void;
}

/**
 * The form that stands between «clicked a position» and «one person differs from their role».
 *
 * A modal rather than an inline row editor, because the decision is not the click: it is the
 * sentence somebody has to write and the date they have to pick, and a form unfolding inside a
 * table of three hundred rows would put both next to two hundred and ninety-nine irrelevant ones.
 * It is not a destructive-action confirmation either — nothing is confirmed here, something is
 * *composed* (`rules/design-system.mdc` §16).
 *
 * Mounted only while there is a draft, so the form's state is the draft's: closing and reopening on
 * another key starts from an empty reason rather than from the previous one — the same guard against
 * a mis-fill the offboarding dialog next door relies on.
 *
 * **The refusal is rendered here, not toasted.** This dialog is `aria-modal="true"`, so while it is
 * open nothing outside it exists for a screen reader; a toast in the page corner would be a refusal
 * its user is never told about. The mutation therefore declares an `onError` that does nothing but
 * make the global toast stand aside (`rules/tanstack-query.mdc` §10), leaving exactly one signal —
 * this alert. The form stays filled in: a refusal is not a reason to make somebody retype a reason
 * they have already thought about.
 *
 * The focus trap, `Esc`, and the return of focus to the control that opened it are Mantine's
 * (`rules/a11y.mdc` §6) — nothing here overrides them.
 */
export function PermissionOverrideDialog({
  draft,
  isSaving,
  error,
  onSubmit,
  onClose,
}: PermissionOverrideDialogProps) {
  const { t } = useTranslation();

  if (draft === null) return null;

  const refusal =
    error === null || error === undefined ? undefined : IamLib.overrideRefusalMessage(error);

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it
      // reaches a screen reader as «button» — axe reports it as `button-name`, and it was reporting
      // it about this dialog until the label was added. The same defect the offboarding dialog and
      // the pagination controls had.
      closeButtonProps={{ 'aria-label': t('permissions.form.cancel') }}
      onClose={onClose}
      opened
      title={
        draft.effect === 'ALLOW'
          ? t('permissions.form.allowTitle')
          : t('permissions.form.denyTitle')
      }
    >
      <Stack gap="md">
        {refusal === undefined ? null : (
          <Alert color="red" role="alert" title={t('permissions.form.refused')} variant="light">
            {refusal.values === undefined ? t(refusal.key) : t(refusal.key, refusal.values)}
          </Alert>
        )}

        <IamUi.PermissionOverrideForm
          effect={draft.effect}
          initialValues={draft.initialValues}
          isPending={isSaving}
          onCancel={onClose}
          // The draft travels with the values: this component is the last place both are known to
          // exist together, and the hook then needs no guard against a state it cannot be in.
          onSubmit={(values) => {
            onSubmit(draft, values);
          }}
          permission={draft.permission}
        />
      </Stack>
    </Modal>
  );
}
