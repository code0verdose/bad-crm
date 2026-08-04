/**
 * The English catalogue, made obviously not-English and about 40 % longer.
 *
 * Two defects, one transformation. **Length** is R-17 in `docs/product/prd.md`: Russian runs longer
 * than English for the same sentence, and a button sized to «Save» clips «Сохранить» — a pseudo
 * locale surfaces that before a single word is translated. **Marking** is the stronger half: every
 * string that came from the catalogue is wrapped, so anything on screen *without* the wrapper is a
 * string somebody wrote into a component.
 *
 * That second property is what makes this worth more than the lint rule. `i18next/no-literal-string`
 * reads source and sees literals; it cannot see a sentence assembled at runtime, one arriving from a
 * library, or one baked into a default prop. Rendering the tree and looking for unmarked text sees
 * all three, because it asks the finished screen rather than the code that built it.
 */
const OPEN = '⟦';
const CLOSE = '⟧';

/** Padding that survives a glance: not letters, so it never reads as a real translation. */
const PADDING = '·';

/**
 * i18next placeholders and the tags of `Trans` — expanding *inside* one would break the value.
 *
 * Two regexes for one pattern, and the duplication is the point: `.test()` on a `/g` regex advances
 * `lastIndex` and answers differently on the next call with the same input. Splitting needs the
 * global flag, deciding must not have it, and sharing one object between them makes every second
 * decision wrong.
 */
const PRESERVED_SPLIT = /(\{\{[^}]*\}\}|<[^>]+>)/g;
const PRESERVED = /^(?:\{\{[^}]*\}\}|<[^>]+>)$/;

/**
 * `Save` → `⟦Save··⟧`. The padding is proportional, so a long paragraph grows like a long
 * paragraph and a one-word button grows like a one-word button.
 */
export const pseudoLocaliseValue = (value: string): string => {
  const expanded = value
    .split(PRESERVED_SPLIT)
    .map((piece) =>
      PRESERVED.test(piece) ? piece : piece + PADDING.repeat(Math.ceil(piece.length * 0.4)),
    )
    .join('');

  return `${OPEN}${expanded}${CLOSE}`;
};

/** The same tree shape, every leaf pseudo-localised. */
export const pseudoLocalise = (tree: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(tree).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? pseudoLocaliseValue(value)
        : typeof value === 'object' && value !== null
          ? pseudoLocalise(value as Record<string, unknown>)
          : value,
    ]),
  );

/** True for a string that came out of the catalogue rather than out of a component. */
export const isPseudoLocalised = (text: string): boolean =>
  text.includes(OPEN) && text.includes(CLOSE);

export const PSEUDO_MARKERS = { open: OPEN, close: CLOSE } as const;
