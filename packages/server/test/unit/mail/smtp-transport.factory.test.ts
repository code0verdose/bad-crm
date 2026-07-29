import { describe, expect, it } from 'vitest';

import {
  createSmtpTransport,
  smtpUrlWithTimeouts,
} from '@/infrastructure/mail/smtp-transport.factory.js';

/**
 * `nodemailer.createTransport` resolves configuration and opens nothing, so this suite needs no
 * server. What it pins down is that the URL is handed over as a URL: parsing host, port and
 * credentials out of `SMTP_URL` by hand is how a password ends up in a log line or a `+` in a
 * password silently becomes a space.
 */
describe('smtp transport', () => {
  it('is built from SMTP_URL as it stands', () => {
    const transport = createSmtpTransport('smtp://localhost:1025');

    expect(transport).toHaveProperty('sendMail');
    transport.close();
  });

  it('accepts credentials and TLS in the URL without the caller taking it apart', () => {
    const transport = createSmtpTransport(
      'smtps://relay%40example.com:s3cr3t@smtp.example.com:465',
    );

    expect(transport).toHaveProperty('sendMail');
    transport.close();
  });
});

/**
 * The timeouts nodemailer would otherwise apply are wrong for this product: two minutes to connect,
 * thirty seconds for a greeting and **ten minutes** on the socket. A relay that accepts the TCP
 * connection and then says nothing holds the caller for the whole of that, and the caller here is a
 * request thread on a single-host installation.
 *
 * They are written into the query string rather than passed as a second argument because
 * `nodemailer.createTransport(url, defaults)` treats its second parameter as message defaults, and
 * a configuration object handed in beside a `url` key is discarded outright
 * (`nodemailer/lib/nodemailer.js`). The query string is the one surface `parseConnectionUrl` reads,
 * which also means an operator can override any of them from `.env` — and that an override wins.
 */
describe('smtp timeouts', () => {
  it('bounds connection, greeting and socket, none of them by nodemailer’s default', () => {
    const url = smtpUrlWithTimeouts('smtp://localhost:1025');
    const query = new URLSearchParams(url.split('?')[1] ?? '');

    // Presence first. `Number(null)` is zero, so a bound alone passes on a URL that carries no
    // parameter at all — which is exactly the state this test exists to reject.
    for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
      expect(query.get(key), key).not.toBeNull();
    }

    expect(Number(query.get('connectionTimeout'))).toBeLessThanOrEqual(15_000);
    expect(Number(query.get('greetingTimeout'))).toBeLessThanOrEqual(15_000);
    expect(Number(query.get('socketTimeout'))).toBeLessThanOrEqual(60_000);
  });

  it('leaves an operator’s own value alone', () => {
    const url = smtpUrlWithTimeouts('smtp://localhost:1025?socketTimeout=120000&pool=true');
    const query = new URLSearchParams(url.split('?')[1] ?? '');

    expect(query.get('socketTimeout')).toBe('120000');
    expect(query.get('pool')).toBe('true');
  });

  /** The credential half of the URL is never rebuilt: only the query string is touched. */
  it('does not touch the credentials while adding them', () => {
    const url = smtpUrlWithTimeouts('smtps://relay%40example.com:s3+cr3t@smtp.example.com:465'); // scan-secrets:allow gitleaks:allow

    expect(url.startsWith('smtps://relay%40example.com:s3+cr3t@smtp.example.com:465?')).toBe(true); // scan-secrets:allow gitleaks:allow
  });
});
