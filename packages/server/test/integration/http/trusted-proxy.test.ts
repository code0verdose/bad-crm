import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createAuthApp } from '../../support/auth-app.util.js';

/**
 * Whose word the process takes for the caller's address.
 *
 * `X-Forwarded-For` is a request header: anybody who can reach the port can write one. It becomes
 * evidence only where a proxy the operator runs has appended the real peer and Express is told how
 * many such hops to skip. The number is therefore configuration — `TRUSTED_PROXY_HOPS` — and its
 * default is `0`, because the shipped `docker-compose.yml` contains no reverse proxy at all
 * (`docs/runbooks/install.md` §3: the operator installs Caddy, nginx or Traefik themselves).
 *
 * A hard-coded `1` on that deployment is not a small inaccuracy. The address ends up in
 * `sessions.ip_hash` and `sessions.ip_masked`, so the owner of an account reads a network the
 * request never came from on `/settings/security`, and an incident investigation reads values the
 * attacker chose. It is also the rate limiter's key: one header per request would mint a fresh
 * budget every time (STORY-006-07).
 *
 * The masked network of the session row is what these assert, because that is the column the harm
 * lands in. Supertest connects over loopback, so the socket address is `127.0.0.1`.
 */

const PASSWORD = 'correct-horse-battery';
const FORGED = '198.51.100.7';

const signIn = async (app: Parameters<typeof request>[0], forwardedFor?: string): Promise<void> => {
  const call = request(app).post('/api/v1/auth/login');

  if (forwardedFor !== undefined) call.set('X-Forwarded-For', forwardedFor);

  await call.send({ email: 'ada@example.com', password: PASSWORD }).expect(200);
};

const maskedAddressOf = (test: ReturnType<typeof createAuthApp>): string =>
  [...test.sessions.rows.values()].at(-1)?.ipMasked ?? '';

describe('with no reverse proxy in front (the default)', () => {
  it('ignores an X-Forwarded-For the client wrote itself', async () => {
    const test = createAuthApp({ trustedProxyHops: 0 });

    await signIn(test.app, FORGED);

    expect(maskedAddressOf(test)).toBe('127.0.0.0/24');
  });

  it('records the socket address when no header is sent at all', async () => {
    const test = createAuthApp({ trustedProxyHops: 0 });

    await signIn(test.app);

    expect(maskedAddressOf(test)).toBe('127.0.0.0/24');
  });

  /**
   * A forged header must not buy a second budget either. The subject the limiter counted is the
   * assertion, because it is computed from the same `req.ip` and would otherwise be the attacker's
   * to choose, one header at a time.
   */
  it('counts the attempt against the address the socket reports', async () => {
    const test = createAuthApp({ trustedProxyHops: 0 });

    await signIn(test.app, FORGED);

    // Loopback is reported as `::ffff:127.0.0.1` on a dual-stack listener and as `127.0.0.1` on an
    // IPv4-only one, so the assertion is about which of the two addresses was counted rather than
    // about how the kernel spelled this one.
    const { ipAddress } = test.rateLimit.consumed[0]?.subject as { ipAddress: string };

    expect(ipAddress).not.toBe(FORGED);
    expect(ipAddress).toContain('127.0.0.1');
  });
});

describe('with one trusted hop configured', () => {
  it('takes the entry that hop appended', async () => {
    const test = createAuthApp({ trustedProxyHops: 1 });

    await signIn(test.app, FORGED);

    expect(maskedAddressOf(test)).toBe('198.51.100.0/24');
    // The positive control for the pair above: with a hop configured the header *is* believed, so
    // the two `describe` blocks differ in their configuration and in nothing else.
    expect(test.rateLimit.consumed[0]?.subject).toMatchObject({ ipAddress: FORGED });
  });

  /**
   * And only that entry. A client that prepends its own chain in front of the proxy's must not be
   * able to choose which of them is believed — with one hop trusted, everything to the left of the
   * proxy's own append is a claim the process does not read.
   */
  it('ignores the entries a client prepended in front of it', async () => {
    const test = createAuthApp({ trustedProxyHops: 1 });

    await signIn(test.app, `10.0.0.1, 192.0.2.55, ${FORGED}`);

    expect(maskedAddressOf(test)).toBe('198.51.100.0/24');
  });
});
