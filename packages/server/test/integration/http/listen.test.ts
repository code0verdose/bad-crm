import { describe, expect, it } from 'vitest';

import { startApiProcess } from '../../../src/infrastructure/bootstrap/api-process.factory.js';
import { createRootLogger } from '../../../src/infrastructure/logging/pino-logger.adapter.js';
import { testEnv } from '../../support/test-app.util.js';

/**
 * The one test that opens a real socket.
 *
 * Everything else in this suite drives the application object through supertest, which never binds
 * a port — so the default `listen` seam, the piece that actually makes the process reachable, would
 * be exercised for the first time in production. Port 0 lets the kernel pick a free one, so the
 * test cannot collide with a running dev server.
 */
describe('the process really binds a port', () => {
  it('listens, answers /health over TCP and gives the port back on shutdown', async () => {
    const lines: string[] = [];
    const signals = new Map<string, () => void>();
    const exitCodes: number[] = [];

    await startApiProcess({
      loadEnvironment: () => testEnv({ PORT: 0, APP_URL: 'http://localhost:3000' }),
      createLogger: (env, requestContext) =>
        createRootLogger(
          { level: env.LOG_LEVEL, version: '0.0.0', requestContext },
          {
            write: (line: string) => lines.push(line),
          },
        ),
      onSignal: (signal, handler) => signals.set(signal, handler),
      exit: (code) => exitCodes.push(code),
    });

    const startup = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['msg'] === 'api process listening');

    expect(startup).toBeDefined();

    const port = (startup?.['port'] as number | undefined) ?? 0;
    // Port 0 in the configuration, a real port in the log: the value comes from the bound socket.
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${String(port)}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'alive' });

    signals.get('SIGTERM')?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exitCodes).toEqual([0]);
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow();
  });
});
