import { describe, expect, it } from 'vitest';

import { invitationLocaleOf } from './invitation-locale.enums.js';

/**
 * Which language the invitation letter is offered in.
 *
 * The recipient has no account, so there is nothing to read a language from — the best available
 * guess is the language the inviter is working in. The narrowing has to match the server's, which
 * answers `ru` to anything Russian and English to everything else: a screen that offered `de` would
 * be offering a letter nobody can render.
 */
describe('the language an invitation is offered in', () => {
  it.each(['ru', 'RU', 'ru-RU', ' ru '])('answers Russian for %s', (language) => {
    expect(invitationLocaleOf(language)).toBe('ru');
  });

  it.each(['en', 'en-GB', 'de-DE', 'cimode', ''])('answers English for %s', (language) => {
    expect(invitationLocaleOf(language)).toBe('en');
  });
});
