import { describe, expect, it } from 'vitest';

import {
  createSmtpTransport,
  smtpUrlWithDefaults,
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
    const url = smtpUrlWithDefaults('smtp://localhost:1025');
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
    const url = smtpUrlWithDefaults('smtp://localhost:1025?socketTimeout=120000&pool=true');
    const query = new URLSearchParams(url.split('?')[1] ?? '');

    expect(query.get('socketTimeout')).toBe('120000');
    expect(query.get('pool')).toBe('true');
  });

  /** The credential half of the URL is never rebuilt: only the query string is touched. */
  it('does not touch the credentials while adding them', () => {
    const url = smtpUrlWithDefaults('smtps://relay%40example.com:s3+cr3t@smtp.example.com:465'); // scan-secrets:allow gitleaks:allow

    expect(url.startsWith('smtps://relay%40example.com:s3+cr3t@smtp.example.com:465?')).toBe(true); // scan-secrets:allow gitleaks:allow
  });
});

/**
 * TLS, on a URL that does not ask for it.
 *
 * `smtp://` is plaintext until STARTTLS is negotiated, and nodemailer negotiates it *opportunis-
 * tically*: a relay that does not advertise `STARTTLS` — or one an active attacker has stripped it
 * from — gets the message anyway, in the clear. The one message this epic sends is a password-reset
 * link, which is to say a bearer credential for the account, and `MAIL FROM`/`RCPT TO` carry the
 * address of the person it belongs to.
 *
 * So `requireTLS=true` is the default for a relay reached over a network, and the operator keeps
 * the last word: writing `requireTLS=false` or `ignoreTLS=true` in `SMTP_URL` is respected, exactly
 * as an explicit timeout is.
 *
 * **Loopback is the exception, and it is the only one.** `smtp://localhost:1025` is the Mailpit of
 * `.env.example` and of the `default` compose profile, which is bound to `127.0.0.1` and speaks no
 * TLS at all. Traffic that never leaves the host has no segment for anybody to read, and requiring
 * TLS there would refuse every message on every development installation while protecting nothing —
 * `rules/self-host-packaging.mdc` rule 2 on not breaking installations one cannot see.
 */
describe('smtp transport security', () => {
  const queryOf = (url: string): URLSearchParams => new URLSearchParams(url.split('?')[1] ?? '');

  it('requires STARTTLS of a relay reached over the network', () => {
    expect(queryOf(smtpUrlWithDefaults('smtp://relay.example.com:587')).get('requireTLS')).toBe(
      'true',
    );
  });

  it.each([
    ['localhost', 'smtp://localhost:1025'],
    ['127.0.0.1', 'smtp://127.0.0.1:1025'],
    ['::1', 'smtp://[::1]:1025'],
  ])('leaves a relay on %s alone, which is where the development one is', (_case, url) => {
    expect(queryOf(smtpUrlWithDefaults(url)).get('requireTLS')).toBeNull();
  });

  /**
   * The exception list is an exact set of names, and these are the cases that prove it.
   *
   * The comment above `LOOPBACK_HOSTS` already names the threat — `localhost.example.com` is a public
   * name somebody can register — but every case in the table above uses a real loopback name, so a
   * prefix or substring check would pass all of them. These fail on one: they are the hosts an
   * attacker gets to choose, and switching the TLS requirement off for them is the one deployment
   * where it matters most.
   */
  it.each([
    ['a public name that starts with localhost', 'smtp://localhost.example.com:587'],
    ['a public name that starts with the loopback address', 'smtp://127.0.0.1.example.com:587'],
    ['a public name that contains localhost', 'smtp://mail.localhost.attacker.example:587'],
  ])('requires TLS for %s', (_case, url) => {
    expect(queryOf(smtpUrlWithDefaults(url)).get('requireTLS')).toBe('true');
  });

  /**
   * Case is not a position the operator stated. `hostOf` lower-cases, so `LOCALHOST` is the
   * development relay written loudly — without that, a dev installation would suddenly demand
   * STARTTLS from Mailpit, which does not speak it, and every local mail would fail.
   */
  it('recognises the loopback relay whatever case it is written in', () => {
    expect(queryOf(smtpUrlWithDefaults('smtp://LocalHost:1025')).get('requireTLS')).toBeNull();
  });

  /**
   * A stated TLS posture is a *value*, not the presence of a key.
   *
   * `?secure=false` and `?ignoreTLS=false` are the plaintext default of `smtp://` spelled out; they
   * assert nothing. Counting them as «the operator has decided» — which is what a `query.has(key)`
   * check does — silently drops the requirement for the copy-paste most likely to appear in a
   * config, and `?secure=false` is a very common one.
   */
  it.each([
    ['secure=false', 'smtp://relay.example.com:587?secure=false'],
    ['ignoreTLS=false', 'smtp://relay.example.com:587?ignoreTLS=false'],
    ['requireTLS with no value', 'smtp://relay.example.com:587?requireTLS'],
  ])('still requires TLS when the URL only says %s', (_case, url) => {
    expect(queryOf(smtpUrlWithDefaults(url)).get('requireTLS')).toBe('true');
  });

  /** `smtps://` is TLS from the first byte; a STARTTLS flag on it would describe nothing. */
  it('adds nothing to an implicit-TLS URL', () => {
    expect(
      queryOf(smtpUrlWithDefaults('smtps://smtp.example.com:465')).get('requireTLS'),
    ).toBeNull();
  });

  it.each([
    ['requireTLS', 'smtp://relay.example.com:587?requireTLS=false', 'requireTLS', 'false'],
    ['ignoreTLS', 'smtp://relay.example.com:587?ignoreTLS=true', 'requireTLS', null],
    ['secure', 'smtp://relay.example.com:587?secure=true', 'requireTLS', null],
  ])('leaves the decision to an operator who wrote %s', (_case, url, key, expected) => {
    expect(queryOf(smtpUrlWithDefaults(url)).get(key)).toBe(expected);
  });

  it('still bounds the timeouts of a relay it required TLS of', () => {
    const query = queryOf(smtpUrlWithDefaults('smtp://relay.example.com:587'));

    expect(query.get('requireTLS')).toBe('true');
    expect(query.get('socketTimeout')).not.toBeNull();
  });
});
