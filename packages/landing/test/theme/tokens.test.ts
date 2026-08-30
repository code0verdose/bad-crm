import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contrastRatio, roundRatio } from './contrast.util.js';

/**
 * Every text colour of the landing page against every surface it is written on.
 *
 * **The page had none of this, and it cost a real defect.** `--bcl-text-faint` was `#656d85`:
 * 3.89:1 on `--bcl-bg` and 3.69:1 on `--bcl-surface`, against the 4.5:1 that `rules/a11y.mdc` §1
 * requires. It is used in more than fifty declarations, and in the great majority of them with
 * `--bcl-text-xs` (13 px) — «always» is what this said until 2026-08-30, and it is not quite true:
 * two rules pair it with `--bcl-text-sm` (15 px) and six with literal `0.65rem`/`0.6rem`. Every one
 * of those is far below the 24 px the large-text exemption starts at, so the conclusion is the one
 * the sentence was reaching for: the 3:1 exemption for large text applies nowhere. Among what it painted: the inactive half of the
 * language switch — the very control a Russian-speaking visitor looks for — and the disclaimer
 * saying the page is a prototype.
 *
 * **Why axe did not catch it.** `test/app/axe.test.tsx` disables the `color-contrast` rule, and
 * honestly says why: jsdom lays nothing out, so axe cannot resolve a computed colour. That is a
 * correct decision about axe and leaves the property unchecked — which is what this file is for.
 * The client package has had the same pair of files since EPIC-007; the landing package never did.
 *
 * The tokens are read out of the stylesheet rather than repeated here: a copy would be a second
 * palette, and the copy that is wrong is the one nobody looks at.
 */

/**
 * Resolved from the package root, not from `import.meta.url`.
 *
 * This suite runs in jsdom, where `import.meta.url` is an `http:` URL and `fileURLToPath` refuses
 * it. `process.cwd()` is the package directory — vitest runs each project from its own root.
 */
const TOKENS_PATH = resolve(process.cwd(), 'src/app/styles/tokens.css');

/** `--bcl-text-faint: #656d85;` → `['bcl-text-faint', '#656d85']`, opaque hex values only. */
const tokens = (): Map<string, string> => {
  const declared = new Map<string, string>();

  for (const [, name, value] of readFileSync(TOKENS_PATH, 'utf8').matchAll(
    /--(bcl-[\w-]+):\s*(#[\da-fA-F]{6})\s*;/g,
  )) {
    if (name !== undefined && value !== undefined) declared.set(name, value);
  }

  return declared;
};

/**
 * The pairs the page actually renders: body text on the page, and on a raised card.
 *
 * `--bcl-text-faint` is included deliberately even though the name suggests decoration — it carries
 * sentences a visitor is expected to read, which is the only thing that decides whether 4.5:1
 * applies.
 */
const FOREGROUNDS = ['bcl-text', 'bcl-text-muted', 'bcl-text-faint'] as const;
const BACKGROUNDS = ['bcl-bg', 'bcl-bg-deep', 'bcl-surface', 'bcl-surface-raised'] as const;

const AA_NORMAL = 4.5;

describe('the landing palette', () => {
  it('CONTROL: reads its colours out of the stylesheet', () => {
    const declared = tokens();

    expect(declared.size).toBeGreaterThan(10);
    for (const name of [...FOREGROUNDS, ...BACKGROUNDS]) {
      expect(declared.has(name), `${name} is not declared as an opaque hex`).toBe(true);
    }
  });

  it('writes every text colour at AA on every surface it can land on', () => {
    const declared = tokens();
    const failures: string[] = [];

    for (const foreground of FOREGROUNDS) {
      for (const background of BACKGROUNDS) {
        const ratio = contrastRatio(
          declared.get(foreground) as string,
          declared.get(background) as string,
        );

        if (ratio < AA_NORMAL) {
          failures.push(`${foreground} on ${background}: ${String(roundRatio(ratio))}:1`);
        }
      }
    }

    expect(
      failures,
      'WCAG 2.1 AA asks 4.5:1 for text below 24px, and every one of these pairs carries sentences',
    ).toEqual([]);
  });

  it('CONTROL: the measurement itself separates a passing pair from a failing one', () => {
    expect(roundRatio(contrastRatio('#ffffff', '#000000'))).toBe(21);
    expect(contrastRatio('#656d85', '#07080c')).toBeLessThan(AA_NORMAL);
  });
});
