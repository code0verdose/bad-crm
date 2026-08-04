/**
 * `localStorage`, for browsers that refuse to have one.
 *
 * Reading it is not a safe operation: Safari and Firefox with storage blocked, an embedded webview,
 * an iframe without storage access — all of them throw `SecurityError` on the *first property
 * access*, not on the read. Two of those reads happen during the first render (the language, the
 * cookie answer), so an unguarded one does not degrade the page, it removes it.
 *
 * Losing the value is the correct fallback for both callers: the language falls back to detection,
 * and an unanswered cookie banner is the honest state when the answer cannot be kept anyway.
 */
export const readStored = (key: string): string | null => {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const writeStored = (key: string, value: string): void => {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    /* Nothing to do and nothing to tell the reader: the page works, the choice just will not
       survive a reload. */
  }
};

export const removeStored = (key: string): void => {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    /* As above. */
  }
};
