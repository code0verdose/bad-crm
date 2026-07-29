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
 * Hosts whose traffic never reaches a network interface, and are therefore the one exemption from
 * the TLS default below.
 *
 * Written as an exact set rather than a prefix or a regular expression: `localhost.example.com` is a
 * public name, and a check that accepted it would switch the requirement off for the one deployment
 * an attacker gets to choose the name of.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether the URL already states a TLS posture, so that ours does not overrule it.
 *
 * By **value**, not by the presence of the key — and the difference is the whole function.
 * `?secure=false` and `?ignoreTLS=false` are the plaintext default of `smtp://` spelled out: they
 * assert nothing, and treating them as a decision quietly dropped the requirement for what is
 * probably the most copy-pasted pair of query parameters in SMTP configuration.
 *
 * `requireTLS` counts either way, because writing `requireTLS=false` is the documented way to say
 * «this relay genuinely cannot do TLS» — a deliberate opt-out, which is exactly what we want it to
 * be. A bare `?requireTLS` with no value is not a value, so it does not count.
 */
const statesTlsPosture = (query: URLSearchParams): boolean => {
  const requireTls = query.get('requireTLS');

  if (requireTls !== null && requireTls !== '') return true;

  return ['ignoreTLS', 'secure'].some((key) => query.get(key) === 'true');
};

/**
 * `smtp://user:pass@host:port/…` → `host`, lower-cased, with the port, the credentials and
 * everything else off.
 *
 * `new URL` is used to **read** and never to write. The warning below about not round-tripping the
 * URL is about `toString()`: re-serializing normalizes the credential, and normalizing a password
 * quietly makes it a different password. Parsing returns a separate string and leaves `smtpUrl`
 * untouched, which is what the caller goes on to use.
 *
 * A non-special scheme like `smtp:` keeps the case of its host — `new URL('smtp://LocalHost').
 * hostname` is `LocalHost` — so the lower-casing is this function's job, not the parser's. IPv6
 * comes back bracketed, which is how `LOOPBACK_HOSTS` spells it.
 *
 * It throws on a URL that does not parse. `SMTP_URL` has already been through
 * `urlWithScheme(['smtp', 'smtps'])` in the env schema by the time a process reaches here, and a
 * configuration error that refuses the start is the direction `rules/security.mdc` rule 17 asks for.
 */
const hostOf = (smtpUrl: string): string => new URL(smtpUrl).hostname.toLowerCase();

/**
 * `SMTP_URL` with the timeout and TLS defaults filled in, and everything the operator wrote left
 * alone.
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
 * **`requireTLS` is defaulted on, and that is a security default rather than a convenience.** A
 * `smtp://` URL is a plaintext connection on which nodemailer negotiates STARTTLS *opportunis-
 * tically*: a relay that does not advertise it — or one an active attacker has stripped the
 * advertisement from — receives the message in the clear. The one message this epic sends is a
 * password-reset link, which is a bearer credential for an account, and the envelope around it
 * carries the address of the person it belongs to. Opportunistic encryption is the setting under
 * which that is emailed in the open and nothing anywhere says so.
 *
 * The exemption is **loopback, and only loopback**. `.env.example` ships `smtp://localhost:1025` and
 * the `default` compose profile binds Mailpit to `127.0.0.1`; Mailpit speaks no TLS at all, so a
 * blanket requirement would refuse every message on every development installation
 * (`rules/self-host-packaging.mdc`, rule 2 — do not break installations you cannot see) in exchange
 * for protecting a connection that never reaches an interface. `smtps://` is left alone for the
 * opposite reason: it is TLS from the first byte, and a STARTTLS flag on it describes nothing.
 *
 * An operator who states a TLS posture keeps it: this fills gaps, it does not override. What counts
 * as stating one is decided by `statesTlsPosture` **by value** — `?secure=false` and
 * `?ignoreTLS=false` restate the plaintext default and are not a decision, so they do not switch the
 * requirement off. The upgrade path for an installation whose relay genuinely cannot do TLS is
 * `?requireTLS=false`: written down, where the next person can see the decision.
 */
export const smtpUrlWithDefaults = (smtpUrl: string): string => {
  const separator = smtpUrl.indexOf('?');
  const base = separator === -1 ? smtpUrl : smtpUrl.slice(0, separator);
  const query = new URLSearchParams(separator === -1 ? '' : smtpUrl.slice(separator + 1));

  for (const [key, value] of Object.entries(TIMEOUT_DEFAULTS)) {
    if (!query.has(key)) query.set(key, value);
  }

  const plaintext = base.toLowerCase().startsWith('smtp://');
  const stated = statesTlsPosture(query);

  if (plaintext && !stated && !LOOPBACK_HOSTS.has(hostOf(base))) query.set('requireTLS', 'true');

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
  createTransport(smtpUrlWithDefaults(smtpUrl));
