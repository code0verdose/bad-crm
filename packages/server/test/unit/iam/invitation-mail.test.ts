import { describe, expect, it } from 'vitest';

import { renderInvitationMail } from '@/domain/iam/invitation-mail.util.js';

/**
 * The invitation letter.
 *
 * The properties worth asserting are the ones a wording change must not break: the token appears in
 * the link and nowhere else, both languages are actually different messages, and the organization
 * name reaches the HTML escaped — it is the one part of this letter written by a person, and it is
 * rendered inside a mail client that runs no CSP of ours.
 */

const input = {
  appUrl: 'https://crm.example.test/',
  token: 'tok-en-value',
  organizationName: 'Acme',
  expiresAt: new Date('2026-08-14T10:00:00.000Z'),
  locale: 'en' as const,
};

describe('the invitation letter', () => {
  it('puts the token in the link and in nothing else', () => {
    const mail = renderInvitationMail(input);

    expect(mail.text).toContain('https://crm.example.test/invite/tok-en-value');
    // Not in the subject: subjects are shown on lock screens and in mailbox previews, which is the
    // part of a message most likely to be read by somebody standing nearby.
    expect(mail.subject).not.toContain(input.token);
    expect(mail.text.split(input.token)).toHaveLength(2);
  });

  it('writes Russian for a Russian invitation and English for an English one', () => {
    const en = renderInvitationMail(input);
    const ru = renderInvitationMail({ ...input, locale: 'ru' });

    expect(en.subject).not.toBe(ru.subject);
    expect(ru.text).toContain('Acme');
    expect(ru.text).toMatch(/[а-яё]/i);
  });

  it('escapes the organization name in the HTML part', () => {
    const mail = renderInvitationMail({ ...input, organizationName: '<script>x</script>' });

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('names the day the link stops working, in the reader’s calendar', () => {
    // The date rather than «7 days»: a letter read on Friday about a link that expires «in a week»
    // says nothing a reader can act on, and the row is the only thing that actually decides.
    expect(renderInvitationMail(input).text).toContain('14');
  });
});
