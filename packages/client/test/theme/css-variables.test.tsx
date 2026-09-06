import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Providers } from '@app/providers.js';
import { QueryClient } from '@tanstack/react-query';

/**
 * The variables the application actually emits, read off the document rather than off the config.
 *
 * `appCssVariables` re-points `--mantine-color-dimmed`, which is the colour Mantine's own
 * components put on the description under an input, a checkbox and a table caption — text this
 * repository never writes, and text `@axe-core/playwright` measured at 3.32:1 on `/settings/security`.
 * Renaming `c="dimmed"` in our JSX does nothing for it; only the variable does.
 *
 * Everything about that fix is invisible to the rest of the suite. `tokens.test.ts` reads
 * `tokens.css` and this variable is not in it; `scheme-selectors.test.ts` compiles that same file;
 * a component test renders happily whatever the variable says, because jsdom applies no stylesheet.
 * So the one thing worth asserting is the one thing none of them can see: that the resolver is
 * wired into `MantineProvider` and its value reaches the style block Mantine renders.
 *
 * A resolver that is written and not passed is the failure this exists for, and it looks exactly
 * like a resolver that is passed: the config file is right there, and every screen still renders.
 */
describe('the application css variables', () => {
  const mantineStyles = (container: HTMLElement): string =>
    [...container.querySelectorAll('style[data-mantine-styles]')]
      .map((element) => element.textContent ?? '')
      .join('\n');

  it('re-points Mantine muted text at the measured token, in both schemes', () => {
    const { container } = render(
      <Providers queryClient={new QueryClient()}>
        <div />
      </Providers>,
    );

    const css = mantineStyles(container);

    expect(css).toContain('--mantine-color-dimmed: var(--bc-text-muted)');
    // Twice, not once: the light and dark blocks are separate rules, and a resolver that fills in
    // one of them leaves the other scheme on Mantine's `dark-2`, which measured 4.03:1.
    expect(css.match(/--mantine-color-dimmed: var\(--bc-text-muted\)/g)).toHaveLength(2);
  });

  /**
   * The semantic scales have to arrive the same way. They are declared on `theme.colors`, so
   * Mantine generates `--mantine-color-warning-1` … `-9` for them — and `tokens.css` names those
   * variables. A token pointing at a variable nothing declares resolves to nothing at all, which
   * renders as transparent text rather than as an error.
   */
  it('declares the semantic scales the tokens are written against', () => {
    const { container } = render(
      <Providers queryClient={new QueryClient()}>
        <div />
      </Providers>,
    );

    const css = mantineStyles(container);

    for (const scale of ['danger', 'warning', 'success', 'info', 'neutral']) {
      expect(css, scale).toContain(`--mantine-color-${scale}-0:`);
      expect(css, scale).toContain(`--mantine-color-${scale}-9:`);
      expect(css, scale).toContain(`--mantine-color-${scale}-light-color:`);
    }
  });

  /**
   * The remap that takes `-text` and `-outline` off `primaryShade`, asserted where it is emitted.
   *
   * `tokens.test.ts` measures the *contrast* of the remapped pairs by calling the resolvers
   * directly, which is the only way to get a colour out of jsdom — it applies no stylesheet, so
   * `getComputedStyle` on a rendered alert returns the `var(...)` text and never a hex. What that
   * cannot prove is that the resolver is wired: a remap written and not passed measures perfectly
   * and ships the 4.02:1. So the pairs are measured there and their arrival is asserted here, on
   * the style block `MantineProvider` really renders, in both schemes.
   */
  it('takes outline and text off the primary shade for every scale, in both schemes', () => {
    const { container } = render(
      <Providers queryClient={new QueryClient()}>
        <div />
      </Providers>,
    );

    const css = mantineStyles(container);

    for (const scale of ['brand', 'danger', 'warning', 'success', 'info', 'neutral']) {
      for (const variable of ['text', 'outline']) {
        // Shade 9 in the light scheme — what `variant="light"` already puts on that same tint.
        expect(css, `light: ${scale}`).toContain(
          `--mantine-color-${scale}-${variable}: var(--mantine-color-${scale}-9)`,
        );
        // Shade 3 in the dark one, one step lighter than the shade 4 Mantine derives there.
        expect(css, `dark: ${scale}`).toContain(
          `--mantine-color-${scale}-${variable}: var(--mantine-color-${scale}-3)`,
        );
      }
    }
  });
});
