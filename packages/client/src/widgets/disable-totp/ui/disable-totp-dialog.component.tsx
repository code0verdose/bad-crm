import {
  Alert,
  Button,
  Group,
  List,
  Modal,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { AuthModel, AuthService } from '@units/auth';

/**
 * The longest a `code` may be, straight from `DisableTotpRequest` in `docs/api/openapi.yaml`.
 *
 * Enforced at the keystroke rather than after the round trip, on the bargain
 * `totp-code-field.component.tsx` makes at six: refusing the character is kinder than accepting it
 * and answering with the one opaque refusal this operation has.
 */
const CODE_MAX_LENGTH = 32;

export interface DisableTotpDialogProps {
  /** Closed with nothing changed — the safe outcome, and the one `Escape` produces. */
  readonly onCancel: () => void;
  /** The factor is off. The screen this dialog was opened from is about to stop existing. */
  readonly onDisabled: () => void;
}

/**
 * Turning the second factor off, behind a confirmation that says what it costs.
 *
 * **The consequences are listed before the fields, not after.** Two of the three are things nobody
 * can find out afterwards: the account drops back to a password alone, and every remaining recovery
 * code is destroyed in the same transaction. The third — that turning it back on is a new secret and
 * a new set of codes — is what stops «off» reading as a switch somebody can flick back.
 *
 * **No typed confirmation**, and that is a judgement rather than an omission (`rules/design-system.mdc`
 * §17 offers three levels). The password and the second-factor code below *are* the confirmation, and
 * they are a far stronger one than typing a name back: this is the only destructive action in the
 * product that re-proves both factors. Adding a third thing to type would be ceremony on top of
 * proof.
 *
 * **One field for the code**, because the server accepts either shape and decides for itself
 * (`disable-totp-form.schema.ts` says why at length). Nothing here inspects what was typed.
 *
 * **The refusal is rendered here rather than left to the global toast**, and it sits above both
 * fields rather than under either. The dialog is `aria-modal="true"`, so while it is open nothing
 * outside it is in the accessibility tree a screen reader is confined to; and `403
 * reauthentication_required` answers a wrong password, a wrong code and an already-spent recovery
 * code alike — attaching it to a field would claim knowledge the server deliberately refused to
 * give (`rules/errors-and-toasts.mdc` §2–§4). It arrives already as a sentence key, from
 * `useTotpDisposal`, which is also where the request is started from: this dialog used to call the
 * mutation through the unit's flat barrel and translate the error itself, which skipped the middle
 * link of the call chain (`rules/frontend-fsd.mdc` rule 4).
 *
 * **Nothing is cleared on a refusal.** The form keeps what was typed, because the retry after an
 * expired TOTP code should cost one field and not the whole password again.
 *
 * `returnFocus={false}`: where the focus goes when this closes depends on *why* it closed — back to
 * the trigger when nothing happened, to the page heading when the trigger no longer exists. That is
 * one decision and it is made by the widget above, which is the thing that knows both answers.
 */
export function DisableTotpDialog({ onCancel, onDisabled }: DisableTotpDialogProps) {
  const { t } = useTranslation();
  const disposal = AuthService.useTotpDisposal();

  const form = useForm<AuthModel.DisableTotpFormValues>({
    mode: 'uncontrolled',
    initialValues: { password: '', code: '' },
    // The resolver answers with an issue per field — an i18n **key** and the bound that refused
    // (`rules/i18n.mdc` §1), not a sentence. Without this step React is handed an object as a child
    // and the render throws; the form would not ship untranslated, it would not ship at all.
    validate: (values) =>
      SharedLib.translateFormIssues(
        SharedLib.zodFormResolver(AuthModel.disableTotpFormSchema)(values),
        t,
      ),
  });

  return (
    <Modal
      // Mantine renders the close control as an icon button with no text, so without this it reaches
      // a screen reader as «button» — axe reports it as `button-name`.
      closeButtonProps={{ 'aria-label': t('security.disable.close') }}
      onClose={onCancel}
      opened
      returnFocus={false}
      title={t('security.disable.dialog.title')}
    >
      <form
        noValidate
        onSubmit={form.onSubmit(
          (values) => {
            // The form values **are** the request body — same two names, no mapping between them.
            disposal.disable({ password: values.password, code: values.code }, onDisabled);
          },
          (errors) => {
            form.getInputNode(SharedLib.firstInvalidField(errors))?.focus();
          },
        )}
      >
        <Stack gap="md">
          <Text>{t('security.disable.description')}</Text>

          <List size="sm">
            <List.Item>{t('security.disable.consequence.passwordOnly')}</List.Item>
            <List.Item>{t('security.disable.consequence.codes')}</List.Item>
            <List.Item>{t('security.disable.consequence.again')}</List.Item>
          </List>

          {disposal.failure !== undefined && (
            // `role="alert"`, so it is announced rather than merely drawn: attention is on the
            // button that was just pressed (`rules/a11y.mdc` §13).
            <Alert
              color="danger"
              role="alert"
              title={t('security.disable.failed.title')}
              variant="light"
            >
              <Text size="sm">{t(disposal.failure.key, disposal.failure.values ?? {})}</Text>
            </Alert>
          )}

          {/* The same hand-set `aria-invalid` as everywhere a `PasswordInput` carries an error. */}
          <PasswordInput
            aria-invalid={form.errors['password'] !== undefined}
            autoComplete="current-password"
            key={form.key('password')}
            label={t('security.disable.password.label')}
            required
            {...form.getInputProps('password')}
          />

          <TextInput
            // `one-time-code` even though a recovery code may be typed here: it is what makes a
            // phone offer the code from its notification, and it costs the recovery-code path
            // nothing.
            autoComplete="one-time-code"
            description={t('security.disable.code.description')}
            key={form.key('code')}
            label={t('security.disable.code.label')}
            maxLength={CODE_MAX_LENGTH}
            required
            {...form.getInputProps('code')}
          />

          {/* Cancel first in the DOM: the safe choice is the one a keyboard reaches without aiming
              (`rules/a11y.mdc` §6). */}
          <Group justify="flex-end">
            <Button onClick={onCancel} variant="default">
              {t('security.disable.cancel')}
            </Button>
            <Button color="danger" loading={disposal.isPending} type="submit">
              {t('security.disable.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
