import { TextInput, type TextInputProps } from '@mantine/core';

/**
 * The four attributes are fixed and cannot be overridden — that is the entire reason this type
 * exists rather than `TextInputProps`.
 */
export type TotpCodeFieldProps = Omit<
  TextInputProps,
  'autoComplete' | 'inputMode' | 'maxLength' | 'type'
>;

/**
 * The six-digit field, wherever a code is asked for.
 *
 * A wrapper is normally not worth having (`rules/design-system.mdc` §7), and this one earns its
 * place on the terms §8 sets out: it fixes four props that must be identical every time, in two
 * forms today, and every one of them is an accessibility requirement of the story rather than a
 * style choice (STORY-013-01, acceptance 10).
 *
 * - **`autoComplete="one-time-code"`** is what makes a phone offer the code from the notification
 *   instead of making somebody memorise six digits and switch apps twice.
 * - **`inputMode="numeric"`** brings up the digit keypad. Paired with `type="text"`, not
 *   `type="number"`: a number input strips leading zeros, and `012345` is a perfectly ordinary TOTP
 *   output — the same trap `totp-code.schema.ts` avoids by refusing `z.coerce.number()`.
 * - **`maxLength`** stops the seventh keystroke rather than letting the form refuse afterwards.
 *
 * Everything else — label, description, `error`, the `@mantine/form` spread — is passed through, so
 * the field keeps Mantine's `aria-invalid` and `aria-describedby` wiring (`rules/a11y.mdc` §18).
 */
export function TotpCodeField(props: TotpCodeFieldProps) {
  return (
    <TextInput
      autoComplete="one-time-code"
      inputMode="numeric"
      maxLength={6}
      type="text"
      {...props}
    />
  );
}
