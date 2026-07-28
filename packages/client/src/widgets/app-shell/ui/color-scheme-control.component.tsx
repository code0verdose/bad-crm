import { SegmentedControl } from '@mantine/core';

import { SharedHooks } from '@shared';

/**
 * `system | light | dark`, with `system` first because it is the default
 * (`rules/design-system.mdc` §4).
 *
 * A segmented control rather than a two-state toggle: a toggle can express «light» and «dark» but
 * not «whatever the operating system says», and dropping the third option is how a product ends up
 * ignoring a user who switches their machine to dark at sunset.
 *
 * The change is applied by Mantine and persisted by it; this component only says which one was
 * chosen (`rules/frontend-fsd.mdc` — markup and handlers, no logic).
 */
export function ColorSchemeControl() {
  const { colorScheme, setColorScheme } = SharedHooks.useColorScheme();

  return (
    <SegmentedControl
      aria-label="common.appearance.colorScheme.aria"
      data={SharedHooks.COLOR_SCHEMES.map((scheme) => ({
        value: scheme,
        label: SharedHooks.COLOR_SCHEME_LABEL_KEY[scheme],
      }))}
      onChange={(value) => {
        setColorScheme(value);
      }}
      size="xs"
      value={colorScheme}
    />
  );
}
