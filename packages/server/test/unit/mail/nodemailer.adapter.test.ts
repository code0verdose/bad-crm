import { describe, expect, it } from 'vitest';

import { NodemailerMailAdapter } from '@/infrastructure/mail/nodemailer.adapter.js';

import { recordedValues, recordingLogger } from '../rate-limit/recording-logger.util.js';
import { FakeMailTransport, smtpError } from './fake-mail-transport.util.js';

const MAIL = {
  to: 'ada.lovelace@example.com',
  subject: 'Reset your Bad CRM password',
  text: 'Open https://crm.example.com/reset-password/9f2c8a1e0b to choose a new password.',
  html: '<p>Open <a href="https://crm.example.com/reset-password/9f2c8a1e0b">this link</a>.</p>',
} as const;

const harness = (): {
  adapter: NodemailerMailAdapter;
  transport: FakeMailTransport;
  lines: ReturnType<typeof recordingLogger>['lines'];
} => {
  const transport = new FakeMailTransport();
  const { logger, lines } = recordingLogger();

  return {
    adapter: new NodemailerMailAdapter(transport, logger, 'Bad CRM <crm@example.com>'),
    transport,
    lines,
  };
};

describe('nodemailer adapter', () => {
  it('reports itself configured — it exists only when there is a transport', () => {
    expect(harness().adapter.isConfigured()).toBe(true);
  });

  it('hands the message to the transport and returns the id the server assigned', async () => {
    const { adapter, transport } = harness();

    const delivery = await adapter.send(MAIL);

    expect(delivery).toEqual({ status: 'sent', messageId: '<1@bad-crm.test>' });
    expect(transport.sent[0]).toMatchObject({
      to: MAIL.to,
      subject: MAIL.subject,
      text: MAIL.text,
    });
  });

  it('sends a text part even when only HTML was given, so the mail is not empty in a text client', async () => {
    const { adapter, transport } = harness();

    await adapter.send({ to: MAIL.to, subject: MAIL.subject, text: MAIL.text });

    expect(transport.sent[0]?.html).toBeUndefined();
    expect(transport.sent[0]?.text).toBe(MAIL.text);
  });
});

/**
 * A failure to deliver is **not** the same answer as "this installation has no mail" — the caller
 * has to be able to tell them apart, because one is a configuration gap the operator must close and
 * the other is a transient fault worth retrying (`mail_not_configured` vs `service_unavailable`,
 * `packages/shared/src/errors/error-code.enums.ts`).
 */
describe('nodemailer adapter — a transport that refuses', () => {
  const cases = [
    { code: 'ECONNECTION', failure: 'connection' },
    { code: 'ETIMEDOUT', failure: 'connection' },
    { code: 'ESOCKET', failure: 'connection' },
    { code: 'EAUTH', failure: 'authentication' },
    // Both halves of the envelope, because nodemailer raises one code for them: a sender the relay
    // refuses and a recipient it refuses are `EENVELOPE` either way, and the missing envelope
    // sender is by far the likelier of the two on a first deployment.
    { code: 'EENVELOPE', failure: 'envelope_rejected' },
    { code: 'ESOMETHINGNEW', failure: 'unknown' },
  ] as const;

  it.each(cases)('reports $code as $failure', async ({ code, failure }) => {
    const { adapter, transport } = harness();
    transport.failure = smtpError(code);

    expect(await adapter.send(MAIL)).toEqual({ status: 'failed', failure });
  });

  it('reports a failure without a code as unknown rather than crashing', async () => {
    const { adapter, transport } = harness();
    transport.failure = new Error('socket hang up');

    expect(await adapter.send(MAIL)).toEqual({ status: 'failed', failure: 'unknown' });
  });

  it('never reports a failure as "not configured": the transport exists, it did not work', async () => {
    const { adapter, transport } = harness();
    transport.failure = smtpError('ECONNECTION');

    expect((await adapter.send(MAIL)).status).not.toBe('not_configured');
  });
});

/**
 * `rules/observability.mdc` rule 5 and `CLAUDE.md` → «Что нельзя логировать никогда»: the recipient
 * is personal data, the subject and the body are user content, and the body of *this* mail contains
 * a single-use credential in a URL. None of it is a debugging convenience worth having.
 */
describe('nodemailer adapter — what reaches the log', () => {
  it('writes neither recipient, subject, body nor the token in the link on success', async () => {
    const { adapter, lines } = harness();

    await adapter.send(MAIL);
    const written = recordedValues(lines);

    expect(written).not.toContain('ada.lovelace@example.com');
    expect(written).not.toContain('Reset your Bad CRM password');
    expect(written).not.toContain('9f2c8a1e0b');
    expect(written).not.toContain('<p>');
  });

  it('writes none of it on failure either, only the class of the failure', async () => {
    const { adapter, transport, lines } = harness();
    transport.failure = smtpError(
      'EAUTH',
      'Invalid login: 535 5.7.8 user smtp-user password hunter2',
    );

    await adapter.send(MAIL);
    const written = recordedValues(lines);

    expect(lines.some((line) => line.level === 'error' || line.level === 'warn')).toBe(true);
    expect(written).toContain('authentication');
    expect(written).not.toContain('hunter2');
    expect(written).not.toContain('ada.lovelace@example.com');
  });
});

describe('nodemailer adapter — shutdown', () => {
  it('closes the pooled connections, so a deploy does not leak sockets', async () => {
    const { adapter, transport } = harness();

    await adapter.close();

    expect(transport.closed).toBe(true);
  });
});
