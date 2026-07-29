import { createTransport } from 'nodemailer';

import { type MailTransport } from '@/infrastructure/mail/mail-transport.types.js';

/**
 * Bounds on how long one delivery attempt may hold a caller, in milliseconds.
 *
 * nodemailer's own defaults are two minutes to connect, thirty seconds for a greeting and **ten
 * minutes** on the socket. On a single-host installation the caller is a request thread, and a relay
 * that accepts the TCP connection and then goes quiet holds it for the whole of that — an
 * unreachable mail server becomes an unresponsive product.
 *
 * The values are deliberately short: everything this application sends is a few kilobytes of text
 * to one recipient, so a healthy relay finishes in well under a second and anything past ten seconds
 * is a relay that is not going to answer.
 */
const TIMEOUT_DEFAULTS: Readonly<Record<string, string>> = {
  connectionTimeout: '10000',
  greetingTimeout: '10000',
  socketTimeout: '30000',
};

/**
 * `SMTP_URL` with the timeout defaults filled in, and everything the operator wrote left alone.
 *
 * **Why the query string and not an options object.** `nodemailer.createTransport(url, defaults)`
 * reads its second argument as *message* defaults, and an object carrying a `url` key plus options
 * has those options discarded outright — `parseConnectionUrl(url)` replaces them
 * (`nodemailer/lib/nodemailer.js`). The query string of the URL is the one surface that reaches the
 * transport, and `parseConnectionUrl` converts numeric values for us.
 *
 * **Why only the query is rebuilt.** The authority half of the URL carries the relay password. A
 * `new URL(...).toString()` round-trip is normalisation, and normalisation of a credential is how a
 * password quietly becomes a different password. `URLSearchParams` is applied to the text after the
 * first `?` and nothing before it is touched.
 *
 * An operator who sets any of these in `.env` keeps their value: this fills gaps, it does not
 * override.
 */
export const smtpUrlWithTimeouts = (smtpUrl: string): string => {
  const separator = smtpUrl.indexOf('?');
  const base = separator === -1 ? smtpUrl : smtpUrl.slice(0, separator);
  const query = new URLSearchParams(separator === -1 ? '' : smtpUrl.slice(separator + 1));

  for (const [key, value] of Object.entries(TIMEOUT_DEFAULTS)) {
    if (!query.has(key)) query.set(key, value);
  }

  return `${base}?${query.toString()}`;
};

/**
 * The SMTP transport of this installation, built from `SMTP_URL` as it stands.
 *
 * The URL is handed to nodemailer whole rather than taken apart into host, port, user and password:
 * a hand-rolled parse is how a `+` in a password silently becomes a space, and how a password ends
 * up in a log line on the way through. Everything the operator can express — `smtps://`, a port, an
 * account, `?requireTLS=true` — is expressed in one place, `.env`.
 *
 * Transport options are not passed as a second argument either, for the same reason: nodemailer
 * reads the query string of the URL (`?pool=true`, `?requireTLS=true`), so an operator who needs a
 * connection pool or a stricter TLS posture writes it in `.env` and no second configuration surface
 * exists to disagree with the first. The timeout defaults above are added to that same query string
 * rather than beside it, which is what keeps that true. `close()` releases whatever the transport
 * holds, which is what makes it a shutdown step (`rules/hexagonal-backend.mdc`, rule 13).
 *
 * Constructing this opens no socket — nodemailer connects on the first message — so a wrong
 * `SMTP_URL` is not a refusal to start. That is deliberate: mail is an optional subsystem
 * (stack.md, «Деградация при отсутствии опционального сервиса»), and an installation must come up
 * and serve everything else while its relay is misconfigured.
 */
export const createSmtpTransport = (smtpUrl: string): MailTransport =>
  createTransport(smtpUrlWithTimeouts(smtpUrl));
