import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '@/app/app.component.js';
import { ROUTES } from '@/shared/lib/use-route.hook.js';

/**
 * `axe-core` was a dependency the rest of the suite never called. The two screens it audits here are
 * the ones every visitor sees without clicking anything first — the landing itself, and one of the
 * legal pages reached through it — which is the same reasoning `packages/client` applies to its own
 * always-shown screens.
 *
 * `color-contrast` is off for the reason it is off in `packages/client`: jsdom paints nothing, so
 * axe would be grading the renderer instead of the design. That leaves the property to
 * `test/theme/tokens.test.ts`, which reads the token file and computes every ratio arithmetically —
 * it was written after this comment said the gap was open, and it found `--bcl-text-faint` at
 * 3.69:1 (fixed in `7dcae42`). Sentence corrected 2026-08-30; the gap is closed.
 *
 * **Every scan carries a `passes` control.** `violations` being empty is also what an empty node
 * answers, so each case asserts that axe had rules to apply and applied them — without it, a render
 * that quietly stopped producing markup would read as a clean audit.
 */
describe('accessibility of the pages a visitor reaches without clicking anything first', () => {
  afterEach(() => {
    globalThis.history.pushState(null, '', '/');
  });

  it('has no axe violations on the home page', async () => {
    const { container } = render(<App />);
    await screen.findAllByRole('heading', { level: 1 });

    const { violations, passes } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    expect(passes.length).toBeGreaterThan(0);
  });

  it('has no axe violations on the /terms legal page', async () => {
    globalThis.history.pushState(null, '', ROUTES.terms);

    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1 });

    const { violations, passes } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    expect(passes.length).toBeGreaterThan(0);
  });
});
