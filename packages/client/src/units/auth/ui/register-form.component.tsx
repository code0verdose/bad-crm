import { Alert, Button, PasswordInput, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { type ErrorMessage } from '@shared/api';
import {
  MAX_ORGANIZATION_NAME,
  MAX_ORGANIZATION_SLUG,
  registerFormSchema,
  type RegisterFormValues,
} from '@units/auth/model';

import classes from './login-form.module.css';

export interface RegisterFormProps {
  /** Carried by the submit button, never by a page-wide spinner or a toast. */
  readonly isPending: boolean;
  /**
   * A refusal that is about the **slug** — today only «that organization already exists». It is
   * rendered under the field, which is where a server's verdict about a field belongs
   * (`rules/errors-and-toasts.mdc` §4).
   */
  readonly slugError?: ErrorMessage | undefined;
  /** A refusal that is about the **password** — the server's half of the policy. Under the field. */
  readonly passwordError?: ErrorMessage | undefined;
  /**
   * A refusal that belongs to no single field: rate limit, an unreadable answer, 500.
   *
   * Rendered as `t(key, values)`, never `t(key)`: the rate limit's sentence has a place for the
   * seconds the server named, and a form that translated the key alone showed the placeholder.
   */
  readonly notice?: ErrorMessage | undefined;
  readonly onSubmit: (values: RegisterFormValues) => void;
}

/**
 * The first door of an installation: an organization, its owner, and no idea what happens next
 * (`rules/frontend-fsd.mdc` rule 7).
 *
 * `@mantine/form` with the shared `zodFormResolver` is the one form stack of this product
 * (ADR-0006 §4): `registerFormSchema` is the source of truth and the resolver turns its issues into
 * the `error` prop of the field they belong to, which is what makes Mantine wire `aria-invalid` and
 * the `aria-describedby` a screen reader needs (`rules/a11y.mdc` §18). The resolver answers
 * synchronously; no schema in this product has an async refinement.
 *
 * **The three server-side refusals arrive as props rather than as toasts**, and they are rendered in
 * three different places on purpose. A taken slug is a statement about one field and joins that
 * field's own error; a password the server's policy refused joins the password field's; everything
 * else — a rate limit, a 500 — is a statement about the request and sits above the fields in an
 * `Alert` with `role="alert"`, so it is announced to somebody who cannot see it appear. Exactly one
 * of them is ever set for one submit, so the screen never says the same thing twice
 * (`rules/errors-and-toasts.mdc` §2).
 *
 * `maxLength` on the two organization fields is the schema's bound rather than a number retyped
 * here: a form that let somebody type a 200-character name only to refuse it on submit would be
 * hiding the rule until the moment it is broken.
 *
 * It shares the sign-in form's stylesheet: same object, same width, one place for it to change.
 */
export function RegisterForm({
  isPending,
  notice,
  passwordError,
  slugError,
  onSubmit,
}: RegisterFormProps) {
  const { t } = useTranslation();

  const form = useForm<RegisterFormValues>({
    mode: 'uncontrolled',
    initialValues: {
      organizationName: '',
      slug: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
    // The resolver answers with an issue per field — an i18n **key** and the bound that refused
    // (`rules/i18n.mdc` §1), not a sentence. Without this step React is handed an object as a child
    // and the render throws; the form would not ship untranslated, it would not ship at all.
    validate: (values) =>
      SharedLib.translateFormIssues(SharedLib.zodFormResolver(registerFormSchema)(values), t),
  });

  return (
    <form
      className={classes['root']}
      noValidate
      onSubmit={form.onSubmit(
        // Named parameter rather than `onSubmit` passed straight through: Mantine also hands the
        // submit event to the handler, and a prop typed «takes the registration» must not quietly
        // receive a second argument nobody declared.
        (values) => {
          onSubmit(values);
        },
        (errors) => {
          form.getInputNode(SharedLib.firstInvalidField(errors))?.focus();
        },
      )}
    >
      <Stack gap="md">
        {notice === undefined ? null : (
          <Alert
            color="warning"
            role="alert"
            title={t(notice.key, notice.values ?? {})}
            variant="light"
          />
        )}

        <TextInput
          autoComplete="organization"
          key={form.key('organizationName')}
          label={t('auth.register.organizationName.label')}
          maxLength={MAX_ORGANIZATION_NAME}
          required
          {...form.getInputProps('organizationName')}
        />

        <TextInput
          autoComplete="off"
          description={t('auth.register.slug.description')}
          key={form.key('slug')}
          label={t('auth.register.slug.label')}
          maxLength={MAX_ORGANIZATION_SLUG}
          required
          {...form.getInputProps('slug')}
          // The form's own issue first: somebody who typed an impossible slug has to fix the shape
          // before «already taken» could even be true. Read at render, which is where derived state
          // belongs (`rules/frontend-fsd.mdc` rule 11) — an effect copying it into form state would
          // be a second copy to leave standing after the next submit.
          error={
            form.errors['slug'] ??
            (slugError === undefined ? undefined : t(slugError.key, slugError.values ?? {}))
          }
        />

        <TextInput
          autoComplete="email"
          key={form.key('email')}
          label={t('auth.register.email.label')}
          required
          type="email"
          {...form.getInputProps('email')}
        />

        {/*
          `aria-invalid` is set by hand on the two masked fields, as on every other form here:
          `TextInput` puts the attribute on the element the label points at, while a `PasswordInput`
          is a wrapper around an inner input plus a visibility toggle, so the attribute lands on the
          wrapper — leaving the control a screen reader reaches described by the error but not
          marked as the invalid one (`rules/a11y.mdc` §18).
        */}
        <PasswordInput
          aria-invalid={form.errors['password'] !== undefined || passwordError !== undefined}
          autoComplete="new-password"
          key={form.key('password')}
          label={t('auth.register.password.label')}
          required
          {...form.getInputProps('password')}
          // The form's own issue first, as on the slug: the server's verdict is only reachable by a
          // password the schema let through, and the two never stand at once.
          error={
            form.errors['password'] ??
            (passwordError === undefined
              ? undefined
              : t(passwordError.key, passwordError.values ?? {}))
          }
        />

        <PasswordInput
          aria-invalid={form.errors['confirmPassword'] !== undefined}
          autoComplete="new-password"
          key={form.key('confirmPassword')}
          label={t('auth.register.confirmPassword.label')}
          required
          {...form.getInputProps('confirmPassword')}
        />

        <Button fullWidth loading={isPending} type="submit">
          {t('auth.register.submit')}
        </Button>
      </Stack>
    </form>
  );
}
