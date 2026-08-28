import { get, type IncomingMessage } from 'node:http';
import { type AddressInfo } from 'node:net';

import { beforeAll, describe, expect, it } from 'vitest';

import { createAuthApp, type AuthApp } from '../../support/auth-app.util.js';

/**
 * The harness itself, under the one usage pattern that used to break it.
 *
 * `AuthApp#server()` memoizes its listener so that a test making several calls pays for one bind
 * instead of one per request; the `afterEach` in `auth-app.util.ts` closes what was opened, so a
 * file does not accumulate sockets. Those two facts contradict each other the moment an `AuthApp`
 * outlives a single test: a `beforeAll`-built one hands the second test the listener `afterEach`
 * already closed, because closing never cleared the memo.
 *
 * Nothing in the suite builds an `AuthApp` in `beforeAll` today, which is exactly why this file
 * exists — the failure would otherwise arrive later, in somebody else's file, and read as a flake.
 * It is also quieter than it sounds: `supertest` re-`listen()`s a server whose `address()` has gone
 * `null`, so a suite driving the app through it would keep passing while paying for a fresh bind per
 * request (the churn this seam was added to stop) and leaving the re-bound socket outside
 * `openServers`, where nothing closes it. A caller that uses the address directly — as here — gets
 * the honest answer instead.
 *
 * `/api/v1/meta` needs neither an account nor a permission, so a failure here can only be the
 * socket.
 */
const fetchStatus = (server: AuthApp['server']): Promise<number> =>
  new Promise((resolve, reject) => {
    const { port } = server().address() as AddressInfo;

    get({ host: '127.0.0.1', port, path: '/api/v1/meta' }, (response: IncomingMessage) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
  });

describe('AuthApp#server() outliving one test', () => {
  let test: AuthApp;

  beforeAll(() => {
    test = createAuthApp();
  });

  it('answers the first test', async () => {
    await expect(fetchStatus(test.server)).resolves.toBe(200);
  });

  it('answers the second test, after afterEach closed the first listener', async () => {
    await expect(fetchStatus(test.server)).resolves.toBe(200);
  });

  it('still memoizes within one test', () => {
    expect(test.server()).toBe(test.server());
    expect(test.server().listening).toBe(true);
  });
});
