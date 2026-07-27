import type { HostPort } from '../connection-target.util.js';
import type { CheckOutcome, ServiceCheck } from '../service-check.types.js';
import { DEV_STACK_REMEDY, withTransportFailure } from './transport.util.js';

/**
 * SMTP is checked by reading the greeting banner and closing the socket — no EHLO, no AUTH, no
 * message. A dev mail catcher that answers `220` is reachable and speaking SMTP, which is the whole
 * question here; anything further would need credentials this script has no business holding.
 */

export const interpretSmtpBanner = (banner: string): CheckOutcome => {
  const first = banner.split('\r\n')[0] ?? '';

  if (first.startsWith('220')) {
    return { status: 'ok', details: [`greeting: ${first.trim()}`] };
  }

  return {
    status: 'failed',
    details: [
      first === ''
        ? 'the port accepted the connection but sent no SMTP greeting'
        : `unexpected SMTP greeting: ${first.trim()}`,
    ],
    remedy: 'check SMTP_URL; in the default dev profile it points at Mailpit on port 1025',
  };
};

export const createSmtpCheck = (options: {
  readonly target: HostPort;
  readonly readBanner: (target: HostPort) => Promise<string>;
}): ServiceCheck => ({
  service: 'smtp',
  requirement: 'optional',
  target: `${options.target.host}:${options.target.port}`,
  run: async () =>
    withTransportFailure(DEV_STACK_REMEDY, async () =>
      interpretSmtpBanner(await options.readBanner(options.target)),
    ),
});
