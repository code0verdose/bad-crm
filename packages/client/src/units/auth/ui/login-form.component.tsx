import { Alert, Button, PasswordInput, Stack, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useForm } from '@mantine/form';

import { SharedLib } from '@shared';

import { firstInvalidField } from '@units/auth/lib';
import { loginFormSchema, type LoginFormValues } from '@units/auth/model';

import classes from './login-form.module.css';

export interface LoginFormProps {
  /** Carried by the submit button, never by a page-wide spinner or a toast. */
  readonly isPending: boolean;
  /** i18n key of something the answer said that is neither a field error nor a failure. */
  readonly noticeKey?: string | undefined;
  readonly onSubmit: (credentials: LoginFormValues) => void;
}

/**
 * The sign-in form: markup, three handlers, and no idea what happens next
 * (`rules/frontend-fsd.mdc` rule 7). Whether the credentials are right is decided by
 * `POST /auth/login`; whether they are *well formed* is decided by `loginFormSchema`, here, before
 * a request is made.
 *
 * `@mantine/form` with the shared `zodFormResolver` is the one form stack of this product
 * (ADR-0006 §4): the schema is the source of truth and the resolver turns its issues into the
 * `error` prop of the field they belong to. Mantine then wires `aria-invalid` and the
 * `aria-describedby` that points at the message — which is what `rules/a11y.mdc` §18 asks for and
 * what a screen reader needs to say *which* field is wrong.
 *
 * The resolver is synchronous: no schema in this product has an async refinement, and answering in
 * the same frame keeps the error and the render together.
 *
 * Focus moves to the first field that failed. Without it, a submit that fails validation announces
 * nothing and leaves the caret where it was — a sighted user sees red, and nobody else learns
 * anything happened.
 *
 * A refused *sign-in* is not shown here: that is one toast, raised once by the global
 * `MutationCache.onError` (`rules/errors-and-toasts.mdc` §3). The `Alert` above the fields is for
 * the answer that is neither success nor failure — an address that belongs to two organizations.
 */
export function LoginForm({ isPending, noticeKey, onSubmit }: LoginFormProps) {
  const { t } = useTranslation();

  const form = useForm<LoginFormValues>({
    mode: 'uncontrolled',
    initialValues: { email: '', password: '' },
    // The resolver answers with an issue per field — an i18n **key** and the bound that refused
    // (`rules/i18n.mdc` §1), not a sentence. Without this step React is handed an object as a child
    // and the render throws; the form would not ship untranslated, it would not ship at all.
    validate: (values) =>
      SharedLib.translateFormIssues(SharedLib.zodFormResolver(loginFormSchema)(values), t),
  });

  return (
    <form
      className={classes['root']}
      noValidate
      onSubmit={form.onSubmit(
        // Named parameter rather than `onSubmit` passed straight through: Mantine also hands the
        // submit event to the handler, and a prop typed «takes the credentials» must not quietly
        // receive a second argument nobody declared.
        (credentials) => {
          onSubmit(credentials);
        },
        (errors) => {
          form.getInputNode(firstInvalidField(errors))?.focus();
        },
      )}
    >
      <Stack gap="md">
        {noticeKey === undefined ? null : (
          <Alert color="warning" role="alert" title={t(noticeKey)} variant="light" />
        )}

        <TextInput
          autoComplete="email"
          key={form.key('email')}
          label={t('auth.login.email.label')}
          required
          type="email"
          {...form.getInputProps('email')}
        />

        {/*
          `aria-invalid` is set by hand, and only on the password field, because Mantine cannot set
          it there. `TextInput` puts the attribute on the element the label points at; a
          `PasswordInput` is a wrapper around an inner input plus a visibility toggle, and the
          attribute lands on the wrapper — so the control a screen reader lands on has the
          `aria-describedby` to the message but nothing saying it is the invalid one
          (`rules/a11y.mdc` §18). Read from `form.errors` at render, which is where derived state
          belongs (`rules/frontend-fsd.mdc` rule 11).
        */}
        <PasswordInput
          aria-invalid={form.errors['password'] !== undefined}
          autoComplete="current-password"
          key={form.key('password')}
          label={t('auth.login.password.label')}
          required
          {...form.getInputProps('password')}
        />

        <Button fullWidth loading={isPending} type="submit">
          {t('auth.login.submit')}
        </Button>
      </Stack>
    </form>
  );
}
