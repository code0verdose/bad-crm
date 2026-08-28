import { get, type IncomingMessage } from 'node:http';
import { type AddressInfo } from 'node:net';

import { beforeAll, describe, expect, it } from 'vitest';

import { createProbeApp, type ProbeApp } from './probe-app.util.js';

/**
 * The same usage pattern as `auth-app-harness.test.ts`, against the other harness.
 *
 * `ProbeApp` carries its own copy of the memoized-listener seam, because it builds its own Express
 * rather than reusing `AuthApp`. A fix applied to one copy and not the other leaves the mine
 * exactly where it was — so the proof is duplicated too, deliberately, rather than trusted to the
 * sibling file.
 *
 * The probe route needs no account and no permission, so a failure here can only be the socket.
 */
const fetchStatus = (server: ProbeApp['server']): Promise<number> =>
  new Promise((resolve, reject) => {
    const { port } = server().address() as AddressInfo;

    get({ host: '127.0.0.1', port, path: '/probe' }, (response: IncomingMessage) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
  });

describe('ProbeApp#server() outliving one test', () => {
  let probe: ProbeApp;

  beforeAll(() => {
    probe = createProbeApp((router) => {
      router.get('/probe', (_request, response) => {
        response.status(200).json({ ok: true });
      });
    });
  });

  it('answers the first test', async () => {
    await expect(fetchStatus(probe.server)).resolves.toBe(200);
  });

  it('answers the second test, after afterEach closed the first listener', async () => {
    await expect(fetchStatus(probe.server)).resolves.toBe(200);
  });

  it('still memoizes within one test', () => {
    expect(probe.server()).toBe(probe.server());
    expect(probe.server().listening).toBe(true);
  });
});
