/**
 * The cookie decision, and the rules it exists to keep.
 *
 * The site sets no cookies and loads no third-party script, so nothing here gates anything today.
 * It is written anyway, and written properly, because the moment analytics is added the wrong
 * default becomes a legal problem rather than a design one:
 *
 * - optional storage is **off** until an explicit yes — no pre-ticked boxes, no “by continuing to
 *   browse you agree”;
 * - refusing is one click, exactly like accepting, and the two buttons look the same weight;
 * - the answer itself is stored, because asking again on every visit is how a consent banner
 *   becomes a dark pattern;
 * - the answer can be withdrawn from the footer at any time.
 *
 * Storage goes through `storage.util.ts`, which survives a browser that refuses to have one.
 */

import { readStored, removeStored, writeStored } from './storage.util.js';

export const CONSENT_STORAGE_KEY = 'bcl-consent';

export type Consent = 'necessary' | 'all';

const isConsent = (value: string | null): value is Consent =>
  value === 'necessary' || value === 'all';

/** The stored answer, or `null` when the visitor has not answered yet. */
export const readConsent = (): Consent | null => {
  const stored = readStored(CONSENT_STORAGE_KEY);
  return isConsent(stored) ? stored : null;
};

export const writeConsent = (consent: Consent): void => {
  writeStored(CONSENT_STORAGE_KEY, consent);
};

export const clearConsent = (): void => {
  removeStored(CONSENT_STORAGE_KEY);
};
