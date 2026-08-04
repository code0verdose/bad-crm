import { afterEach, describe, expect, it } from 'vitest';

import {
  CONSENT_STORAGE_KEY,
  clearConsent,
  readConsent,
  writeConsent,
} from '@/shared/lib/consent.util.js';

/**
 * The consent store is two `localStorage` calls and a type guard, but the guard is the part worth
 * proving: a garbage value left over from an older build (or poked by hand in devtools) has to read
 * back as "not answered yet", not crash the banner logic or get treated as a real answer.
 */
describe('readConsent', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('is null when nothing has been stored', () => {
    expect(readConsent()).toBeNull();
  });

  it('round-trips a stored "necessary" answer', () => {
    writeConsent('necessary');

    expect(readConsent()).toBe('necessary');
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('necessary');
  });

  it('round-trips a stored "all" answer', () => {
    writeConsent('all');

    expect(readConsent()).toBe('all');
  });

  it('treats a garbage value as unanswered rather than as a valid consent', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, 'yes-please');

    expect(readConsent()).toBeNull();
  });

  it('treats an empty string as unanswered', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, '');

    expect(readConsent()).toBeNull();
  });

  it('clearConsent removes the answer, so the next read is null again', () => {
    writeConsent('all');

    clearConsent();

    expect(readConsent()).toBeNull();
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
  });
});
