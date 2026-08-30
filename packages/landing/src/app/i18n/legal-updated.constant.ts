/**
 * The date the three legal documents were last changed — one value, both languages, one file.
 *
 * It used to be six string literals: `terms`, `privacy` and `cookies` each carried their own
 * `updated:` in `dictionary-en.constant.ts` and again in `dictionary-ru.constant.ts`. Nothing
 * checked that the six agreed. The type system cannot: `Copy` is inferred from the English
 * dictionary, so it only knows this field is a string. `dictionary-parity.test.ts` cannot either —
 * it compares the *set of leaf paths* and rejects empty values, which is exactly the check that
 * passes while the two languages show different dates.
 *
 * That is a worse failure than it looks. On an ordinary heading a stale word is a typo; on a
 * document a visitor is asked to accept, the date is part of the content — it is how they tell
 * which version they agreed to, and two versions of the site disagreeing about it is the kind of
 * detail a regulator reads. The realistic path to it is not carelessness but ordinary work:
 * amending a policy in the language you are editing and not scrolling to the other file.
 *
 * So the date stops being copy and becomes a constant. Amending a document is now one edit in one
 * place, and the two renderings sit on adjacent lines where a diff shows both at once.
 *
 * The two strings are not derived from a single machine-readable date on purpose.
 * `Intl.DateTimeFormat('ru-RU')` renders `4 августа 2026 г.`, with the `г.` the Russian copy does
 * not use, so deriving would have meant either changing published wording or hand-patching the
 * output — both worse than writing the month out twice, once, here.
 *
 * The annotation is deliberate and load-bearing: without it TypeScript infers the literal type, the
 * English dictionary's `updated` field narrows to `'4 August 2026'`, and `Copy` then rejects the
 * Russian dictionary for holding a different string. `EN_COPY` avoids `as const` for the same
 * reason.
 */
export const LEGAL_UPDATED: { en: string; ru: string } = {
  en: '4 August 2026',
  /* The escape is the point: the Russian date is written with a non-breaking space, so the day
     cannot be left dangling at the end of a line. Spelled `\u00a0` rather than pasted, because a
     literal one is invisible in a diff and the next editor retypes it as an ordinary space. */
  ru: '4\u00a0августа 2026',
};
