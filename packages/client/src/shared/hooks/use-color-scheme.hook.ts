import { useMantineColorScheme } from '@mantine/core';

/**
 * The three values the switch offers, in the order it shows them. `auto` follows
 * `prefers-color-scheme` and is the default (`rules/design-system.mdc` §4).
 */
export const COLOR_SCHEMES = ['auto', 'light', 'dark'] as const;

export type AppColorScheme = (typeof COLOR_SCHEMES)[number];

/** Labels are keys, never text (`rules/i18n.mdc` §5). */
export const COLOR_SCHEME_LABEL_KEY: Record<AppColorScheme, string> = {
  auto: 'common.appearance.colorScheme.auto',
  light: 'common.appearance.colorScheme.light',
  dark: 'common.appearance.colorScheme.dark',
};

export interface ColorSchemeControl {
  readonly colorScheme: AppColorScheme;
  readonly setColorScheme: (value: AppColorScheme) => void;
}

/**
 * The colour scheme, as the UI needs it.
 *
 * Persistence is Mantine's: `MantineProvider` writes the choice to `localStorage` under
 * `mantine-color-scheme` and applies it to the document before paint, which is what makes the
 * switch survive a reload without a flash of the wrong theme. Re-implementing that here would mean
 * two writers for one setting.
 *
 * What the wrapper adds is the vocabulary: the ordered list the switch renders and the label key of
 * each value, next to the values they label rather than inside the component that draws them. The
 * two types coincide today — Mantine's `MantineColorScheme` is the same three values — and
 * `AppColorScheme` is what the product means by them, so a future Mantine value does not silently
 * become an option in this UI.
 */
export const useColorScheme = (): ColorSchemeControl => {
  const { colorScheme, setColorScheme } = useMantineColorScheme();

  return { colorScheme, setColorScheme };
};
