import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** The levels this product commits to (`rules/a11y.mdc`): WCAG 2.0 and 2.1, A and AA. */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Waits until nothing on the page is still animating.
 *
 * ## Why an audit has to wait for this
 *
 * A contrast check reads the colours the browser is painting *now*. While an element fades in it is
 * painted as a **composite** of itself over whatever sits behind it, so a dialog caught mid-fade
 * reports pairs like `#ecd0d0` on `#b65858` — values that appear in no palette, in no stylesheet and
 * in no design token, and that differ from run to run because they depend on where the transition
 * happened to be when the screenshot was taken.
 *
 * That failure is indistinguishable from a real contrast defect while being immune to every fix for
 * one. It survived an entire palette repair, and the drifting numbers were the only clue that the
 * colours were not real. Waiting removes the whole class: a violation this suite reports afterwards
 * is a fact about the design tokens.
 *
 * `getAnimations()` covers CSS transitions, CSS animations and the Web Animations API in one, which
 * is what makes this independent of how any particular component chooses to move — and that is the
 * whole of the mechanism here.
 *
 * **Corrected 2026-08-30.** This said `prefers-reduced-motion` was «emulated for the whole suite
 * (`playwright.config.ts`)» and called the wait a belt to that pair of braces. There is no
 * `reducedMotion` in that config and never was: the suite runs the **animated** path, which is the
 * right default — `rules/a11y.mdc` puts the reduced-motion pass in the manual checklist, and a
 * suite that only ever saw the still version would stop being able to catch a component that moves
 * when it should not. The preference itself is asserted on both sides where it is cheap to do so,
 * in unit tests (`packages/landing/test/shared/lib/use-scene-progress.hook.test.tsx` and the
 * smooth-scroll provider). So the wait is not a belt to braces; it is the only thing standing
 * between axe and a half-drawn frame.
 */
const settled = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((animation) => animation.playState === 'finished' || animation.playState === 'idle'),
    undefined,
    { timeout: 5_000 },
  );
};

/**
 * Asserts the page has no WCAG A or AA violation, once it has stopped moving.
 *
 * One helper rather than the copy each spec used to carry: the three were identical, and the fix
 * above had to reach all of them — a wait that only some audits perform is a flake that only some
 * runs see.
 */
export const audit = async (page: Page): Promise<void> => {
  await settled(page);

  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();

  expect(
    violations.map((violation) => `${violation.id}: ${violation.help}`),
    JSON.stringify(violations, null, 2),
  ).toEqual([]);
};
