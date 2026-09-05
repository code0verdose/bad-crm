import { Alert, Anchor, Button, Stack, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { twoFactorFormSchema, type TwoFactorFormValues } from '@units/auth/model';

import classes from './login-form.module.css';

/** Which credential the person says they are about to type. It changes the hint, not the field. */
type CodeSource = 'authenticator' | 'recovery';

/** Six digits from an app; anything longer is a recovery code, whose contract bound is 32. */
const CODE_MAX_LENGTH: Readonly<Record<CodeSource, number>> = { authenticator: 6, recovery: 32 };

export interface TwoFactorFormProps {
  /** Carried by the submit button, never by a page-wide spinner or a toast. */
  readonly isPending: boolean;
  /** i18n key of a refused code, chosen from the problem `code` by the unit hook. */
  readonly failureKey: string | undefined;
  /** What is left of the intermediate token's five minutes. */
  readonly secondsLeft: number;
  readonly onSubmit: (values: TwoFactorFormValues) => void;
}

/**
 * The second step of the sign-in: one code, and the two ways of producing one.
 *
 * The form stack is the product's one form stack — `@mantine/form` with the shared
 * `zodFormResolver`, so the schema decides what is well-formed and Mantine wires `aria-invalid` and
 * the `aria-describedby` that points at the message (`rules/design-system.mdc` §11,
 * `rules/a11y.mdc` §18). Whether the code is *right* is decided by `POST /auth/2fa/verify`, and its
 * refusal arrives as `failureKey`.
 *
 * **One field, two hints.** The link switches what the step says and how the field is typed —
 * numeric keypad and six characters for an authenticator, plain text and thirty-two for a recovery
 * code — and never which field is on screen or what is in it. The server decides from the shape of
 * what arrives which check to run (`two-factor.schema.ts` says why at length), so nothing here
 * inspects the value; the switch exists for the person, whose sheet of recovery codes is no help at
 * all while the screen is talking about an app they no longer have.
 *
 * **`autoComplete="one-time-code"` in both modes**, which is what lets a phone offer the code from
 * its notification. `TotpCodeField` is deliberately not reused: it fixes the field at six numeric
 * characters, which is exactly the narrowing this step must not make.
 *
 * **The countdown is plain text, not a live region.** It changes every second, and a polite region
 * that changed every second would talk over everything else a screen reader had to say. What is
 * announced is the thing that happens once: a refused code, in an `Alert` with `role="alert"`
 * (`rules/a11y.mdc` §13).
 *
 * The refusal sits above the field rather than under it, and is not attached to it through
 * `form.setErrors`: `mfa_code_replayed` and a spent recovery code are statements about *this
 * attempt*, not about the characters typed, and the field is left holding them so that a retry
 * costs one keystroke rather than the whole value. The same arrangement, for the same reason, as
 * `disable-totp-dialog.component.tsx`.
 */
export function TwoFactorForm({
  isPending,
  failureKey,
  secondsLeft,
  onSubmit,
}: TwoFactorFormProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<CodeSource>('authenticator');
  const codeRef = useRef<HTMLInputElement>(null);

  const form = useForm<TwoFactorFormValues>({
    mode: 'uncontrolled',
    initialValues: { code: '' },
    // The resolver answers with an issue per field — an i18n **key** and the bound that refused
    // (`rules/i18n.mdc` §1), not a sentence. Without this step React is handed an object as a child
    // and the render throws; the form would not ship untranslated, it would not ship at all.
    validate: (values) =>
      SharedLib.translateFormIssues(SharedLib.zodFormResolver(twoFactorFormSchema)(values), t),
  });

  /**
   * Moving the focus onto a form that has just replaced another one — a real side effect on the
   * DOM, which is the one thing `useEffect` is still for (`rules/frontend-fsd.mdc` rule 11).
   *
   * It cannot be `autoFocus`: `jsx-a11y/no-autofocus` is an error in this repository, and rightly
   * so for a field that is on screen when a page loads. This one is not — it appears in place of
   * the password form, in response to something the person just did — and a caret left on a submit
   * button that no longer exists is how a keyboard user loses their place entirely.
   */
  useEffect(() => {
    codeRef.current?.focus();
  }, []);

  const chooseSource = (next: CodeSource): void => {
    setSource(next);
    // Back to the field the sentence is about, so the person who followed the link is standing where
    // it left them rather than at the top of the form.
    form.getInputNode('code')?.focus();
  };

  return (
    <form
      className={classes['root']}
      noValidate
      onSubmit={form.onSubmit(
        (values) => {
          onSubmit(values);
        },
        () => {
          form.getInputNode('code')?.focus();
        },
      )}
    >
      <Stack gap="md">
        <Text size="sm">
          {source === 'authenticator'
            ? t('auth.twoFactor.description')
            : t('auth.twoFactor.recovery.description')}
        </Text>

        <TextInput
          autoComplete="one-time-code"
          inputMode={source === 'authenticator' ? 'numeric' : 'text'}
          key={form.key('code')}
          label={t('auth.twoFactor.code.label')}
          maxLength={CODE_MAX_LENGTH[source]}
          ref={codeRef}
          required
          // `type="text"` even for six digits: a number input strips a leading zero, and `012345` is
          // an ordinary code — the same trap `totp-code.schema.ts` avoids by refusing coercion.
          type="text"
          {...form.getInputProps('code')}
        />

        {failureKey !== undefined && (
          <Alert
            color="danger"
            role="alert"
            title={t('auth.twoFactor.failed.title')}
            variant="light"
          >
            <Text size="sm">{t(failureKey)}</Text>
          </Alert>
        )}

        <Text c="var(--bc-text-muted)" size="sm">
          {t('auth.twoFactor.expiresIn', { time: SharedLib.formatSecondsClock(secondsLeft) })}
        </Text>

        <Button fullWidth loading={isPending} type="submit">
          {t('auth.twoFactor.submit')}
        </Button>

        {/*
          A button that looks like a link, not a link: it goes nowhere and has no address. Written as
          `Anchor component="button"` so that a keyboard reaches it with Tab and Enter, which a `div`
          with an `onClick` would not (`rules/a11y.mdc` §10).
        */}
        <Anchor
          component="button"
          onClick={() => {
            chooseSource(source === 'authenticator' ? 'recovery' : 'authenticator');
          }}
          size="sm"
          type="button"
        >
          {source === 'authenticator'
            ? t('auth.twoFactor.useRecoveryCode')
            : t('auth.twoFactor.useAuthenticator')}
        </Anchor>
      </Stack>
    </form>
  );
}
