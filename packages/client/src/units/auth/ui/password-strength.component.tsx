import { Progress, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { passwordStrength } from '@units/auth/lib';
import { PASSWORD_STRENGTH_MESSAGE_KEY, type PasswordStrength as Level } from '@units/auth/model';

export interface PasswordStrengthProps {
  /** What is in the field right now. An empty value is the caller's to not render. */
  readonly value: string;
}

/** Colour per level, from the semantic palette — never a literal (`rules/design-system.mdc` §3). */
const LEVEL_COLOR: Readonly<Record<Level, string>> = {
  weak: 'danger',
  fair: 'warning',
  good: 'warning',
  strong: 'success',
};

/** Where the bar sits for each level. Four steps, evenly, because there are four words. */
const LEVEL_FILL: Readonly<Record<Level, number>> = {
  weak: 25,
  fair: 50,
  good: 75,
  strong: 100,
};

/**
 * How the password being typed reads — a sentence, with a bar beside it.
 *
 * **The sentence is the component and the bar is decoration.** Colour is never the only carrier of
 * meaning (`rules/a11y.mdc` §2), and a strength meter is the shape that gets that wrong most often:
 * four shades of one bar say nothing to a reader who cannot see them, and something else entirely to
 * one who sees them differently. So the bar is `aria-hidden` and the words are real text — which is
 * what STORY-006-06's own accessibility criterion asks for, in as many words.
 *
 * **It sits under the field rather than inside it.** The obvious home is the input's `description`,
 * which would put it in `aria-describedby`; Mantine renders that slot as a `<p>`, and a `<p>`
 * cannot contain the bar. Between invalid markup with the association and valid markup with the
 * meter as the next thing a reader reaches, this takes the second: the field keeps its own
 * description for the rule that actually governs the password, and the meter follows it in the
 * reading order.
 *
 * **It is not a live region.** The value changes on every keystroke, and one announcement per
 * character is an announcement nobody can type a password through (`rules/a11y.mdc` §13 is about
 * signals worth interrupting for; this is not one).
 *
 * **It never refuses anything.** See `password-strength.util.ts`: there is no strength policy on the
 * server, so a meter that blocked a submission would invent one on the client.
 */
export function PasswordStrength({ value }: PasswordStrengthProps) {
  const { t } = useTranslation();
  const level = passwordStrength(value);

  return (
    <Stack gap={4}>
      <Text size="sm">{t(PASSWORD_STRENGTH_MESSAGE_KEY[level])}</Text>
      <Progress aria-hidden color={LEVEL_COLOR[level]} size="xs" value={LEVEL_FILL[level]} />
    </Stack>
  );
}
