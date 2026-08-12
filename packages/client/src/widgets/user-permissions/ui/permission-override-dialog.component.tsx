import { Alert, Modal, Stack } from '@mantine/core';
import { useState } from 'react';
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
 * The form is mounted only while the dialog is open, so its state is the draft's: closing and
 * reopening on another key starts from an empty reason rather than from the previous one — the same
 * guard against a mis-fill the offboarding dialog next door relies on. Mantine unmounts the content
 * of a closed `Modal`, which is what keeps that true now that the component itself stays mounted.
 *
 * **The refusal is rendered here, not toasted.** This dialog is `aria-modal="true"`, so while it is
 * open nothing outside it exists for a screen reader; a toast in the page corner would be a refusal
 * its user is never told about. The mutation therefore declares an `onError` that does nothing but
 * make the global toast stand aside (`rules/tanstack-query.mdc` §10), leaving exactly one signal —
 * this alert. The form stays filled in: a refusal is not a reason to make somebody retype a reason
 * they have already thought about.
 *
 * The focus trap, `Esc`, and the return of focus to the control that opened it are Mantine's
 * (`rules/a11y.mdc` §6) — which is why `opened` is a **prop of a permanently rendered `Modal`**
 * rather than the component returning `null` when there is no draft, as it used to.
 *
 * That distinction is the whole of a defect this dialog shipped with. Mantine remembers the control
 * to give the focus back to in `useFocusReturn`, and `useFocusReturn` records it inside
 * `useDidUpdate` — an effect that **skips the first render on purpose**. A `Modal` mounted already
 * open therefore never records anything, and a `Modal` unmounted with the draft never runs the
 * closing half either: cancelling left a keyboard user on `<body>`, at the top of a document whose
 * table is three hundred rows long, with no way back to the row they were on but to tab through the
 * whole shell. Every other dialog in the product passes `opened` and stays mounted; this one is now
 * the same shape, and `test/widgets/user-permissions.test.tsx` holds it there.
 */
export function PermissionOverrideDialog({
  draft,
  isSaving,
  error,
  onSubmit,
  onClose,
}: PermissionOverrideDialogProps) {
  const { t } = useTranslation();

  /**
   * The draft the dialog is **drawn** from, which outlives the one it is open for.
   *
   * `draft` is `null` the instant cancel is pressed, and the dialog is still on screen for the
   * length of its closing transition. Rendering straight from the prop would empty the title and the
   * form for those milliseconds — an ALLOW dialog would announce itself as a DENY on its way out.
   * Adjusting state during render is React's own answer to «a prop changed and some state derives
   * from it»; there is no effect here and nothing to clean up.
   */
  const [shown, setShown] = useState(draft);

  if (draft !== null && draft !== shown) setShown(draft);

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
      opened={draft !== null}
      title={
        shown?.effect === 'DENY'
          ? t('permissions.form.denyTitle')
          : t('permissions.form.allowTitle')
      }
    >
      {shown === null ? null : (
        <Stack gap="md">
          {refusal === undefined ? null : (
            <Alert
              color="danger"
              role="alert"
              title={t('permissions.form.refused')}
              variant="light"
            >
              {refusal.values === undefined ? t(refusal.key) : t(refusal.key, refusal.values)}
            </Alert>
          )}

          <IamUi.PermissionOverrideForm
            effect={shown.effect}
            initialValues={shown.initialValues}
            isPending={isSaving}
            onCancel={onClose}
            // The draft travels with the values: this component is the last place both are known to
            // exist together, and the hook then needs no guard against a state it cannot be in.
            onSubmit={(values) => {
              onSubmit(shown, values);
            }}
            permission={shown.permission}
          />
        </Stack>
      )}
    </Modal>
  );
}
