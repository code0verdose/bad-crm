import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NodemailerMailAdapter } from '@/infrastructure/mail/nodemailer.adapter.js';
import { createSmtpTransport } from '@/infrastructure/mail/smtp-transport.factory.js';

import { recordedValues, recordingLogger } from '../../unit/rate-limit/recording-logger.util.js';

/** Same image `docker-compose.yml` runs, so dev and this suite exercise one SMTP implementation. */
const IMAGE = 'axllent/mailpit:v1.30.5';

const SMTP_PORT = 1025;
const HTTP_PORT = 8025;

/** `MAIL_FROM`, as an installation would set it. */
const MAIL_FROM = 'Bad CRM <crm@example.com>';

interface MailpitMessage {
  readonly ID: string;
  readonly Subject: string;
  readonly From: { readonly Address: string } | null;
  readonly To: readonly { readonly Address: string }[];
}

let container: StartedTestContainer;
let apiUrl: string;

const messages = async (): Promise<readonly MailpitMessage[]> => {
  const response = await fetch(`${apiUrl}/api/v1/messages`);
  const body = (await response.json()) as { messages: MailpitMessage[] };

  return body.messages;
};

const bodyOf = async (id: string): Promise<{ Text: string; HTML: string }> => {
  const response = await fetch(`${apiUrl}/api/v1/message/${id}`);

  return (await response.json()) as { Text: string; HTML: string };
};

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: 'true', MP_SMTP_AUTH_ALLOW_INSECURE: 'true' })
    .withExposedPorts(SMTP_PORT, HTTP_PORT)
    .withWaitStrategy(Wait.forHttp('/readyz', HTTP_PORT))
    .start();

  apiUrl = `http://${container.getHost()}:${container.getMappedPort(HTTP_PORT)}`;
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

beforeEach(async () => {
  await fetch(`${apiUrl}/api/v1/messages`, { method: 'DELETE' });
});

const mailer = (): {
  adapter: NodemailerMailAdapter;
  lines: ReturnType<typeof recordingLogger>['lines'];
} => {
  const { logger, lines } = recordingLogger();
  const smtpUrl = `smtp://${container.getHost()}:${container.getMappedPort(SMTP_PORT)}`;

  return {
    adapter: new NodemailerMailAdapter(createSmtpTransport(smtpUrl), logger, MAIL_FROM),
    lines,
  };
};

/**
 * The adapter against a real SMTP server, read back through Mailpit's HTTP API.
 *
 * A mock of nodemailer would prove that the adapter calls a function; this proves that a mail
 * leaves the process, is accepted by a server, and arrives with the parts it was given — including
 * the case dev actually runs, where the transport takes any credentials over an unencrypted socket.
 */
describe('mail through a live Mailpit', () => {
  it('delivers the message and reports the id the server assigned', async () => {
    const { adapter } = mailer();

    const delivery = await adapter.send({
      to: 'ada.lovelace@example.com',
      subject: 'Reset your Bad CRM password',
      text: 'Open https://crm.example.com/reset-password/9f2c8a1e0b',
      html: '<p>Open <a href="https://crm.example.com/reset-password/9f2c8a1e0b">this link</a>.</p>',
    });

    expect(delivery.status).toBe('sent');
    if (delivery.status !== 'sent') throw new Error('unreachable');
    expect(delivery.messageId).toMatch(/@/);

    const received = await messages();
    expect(received).toHaveLength(1);
    expect(received[0]?.Subject).toBe('Reset your Bad CRM password');
    expect(received[0]?.To[0]?.Address).toBe('ada.lovelace@example.com');
    // The envelope sender is the half Mailpit does *not* insist on: it accepts an empty `MAIL FROM`,
    // which is exactly why this suite was green while no real relay would have taken the message.
    expect(received[0]?.From?.Address).toBe('crm@example.com');

    const body = await bodyOf(received[0]?.ID ?? '');
    expect(body.Text).toContain('reset-password/9f2c8a1e0b');
    expect(body.HTML).toContain('reset-password/9f2c8a1e0b');

    await adapter.close();
  });

  it('writes nothing about the message into the log, not even after a real delivery', async () => {
    const { adapter, lines } = mailer();

    await adapter.send({
      to: 'ada.lovelace@example.com',
      subject: 'Reset your Bad CRM password',
      text: 'Open https://crm.example.com/reset-password/9f2c8a1e0b',
    });
    const written = recordedValues(lines);

    expect(written).not.toContain('ada.lovelace@example.com');
    expect(written).not.toContain('9f2c8a1e0b');

    await adapter.close();
  });

  it('reports a refused connection as a failure and never as "not configured"', async () => {
    const { logger } = recordingLogger();
    // Port 1 is reserved and nothing listens on it: a connection refused in one round trip.
    const adapter = new NodemailerMailAdapter(
      createSmtpTransport('smtp://127.0.0.1:1'),
      logger,
      MAIL_FROM,
    );

    const delivery = await adapter.send({
      to: 'ada.lovelace@example.com',
      subject: 'Reset your Bad CRM password',
      text: 'Open https://crm.example.com/reset-password/9f2c8a1e0b',
    });

    expect(delivery).toEqual({ status: 'failed', failure: 'connection' });

    await adapter.close();
  });
});
