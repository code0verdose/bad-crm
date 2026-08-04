import { SegmentedControl } from '@mantine/core';
import { useTranslation } from 'react-i18next';

// Segment-level aliases rather than the `@shared` barrel: importing the barrel from inside the
// layer it exports is a cycle, and a relative parent (`../../hooks`) is what the lint rule forbids.
// `use-language.hook.ts` reaches `@shared/i18n` the same way.
import { LANGUAGE_LABEL_KEY, useLanguage } from '@shared/hooks';
import { LANGUAGES } from '@shared/i18n';

/**
 * `EN | RU`, in the same shape as the colour-scheme switch beside it.
 *
 * A segmented control rather than a dropdown, and that is the consistency rule doing its job rather
 * than taste (`rules/design-system.mdc`): two mutually exclusive options that both fit on screen
 * are what a segmented control is for, and the control next to it already answers the same kind of
 * question the same way. A `Select` would put the current language behind a click.
 *
 * Each label is written in **its own language** — `English`, `Русский`, never translated. Somebody
 * looking for a way out of a language they cannot read is scanning for the name of the one they
 * can, and «Английский / Русский» is unreadable to exactly the person the control exists for.
 *
 * Lives in `shared/ui` and not in the shell, because the screens that need it most are the public
 * ones: no profile exists at `/login`, and a person who cannot read that form cannot sign in to
 * reach a settings page (`rules/i18n.mdc`).
 */
export function LanguageControl() {
  const { t } = useTranslation();

  const { language, setLanguage } = useLanguage();

  return (
    <SegmentedControl
      aria-label={t('common.appearance.language.aria')}
      data={LANGUAGES.map((value) => ({
        value,
        label: t(LANGUAGE_LABEL_KEY[value]),
      }))}
      onChange={(value) => {
        setLanguage(value);
      }}
      size="xs"
      value={language}
    />
  );
}
