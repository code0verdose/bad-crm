import { apiURL } from './playwright.config.js';

/**
 * Proves the stack is up before the first scenario runs.
 *
 * Without this, a stack that is still migrating turns into a wall of scenario failures whose first
 * line is «expected the sign-in form to be visible» — every one of them a lie about what went
 * wrong. Here the same situation produces one message naming the endpoint that did not answer.
 *
 * `/ready` and not `/health`: liveness only says a process is listening. Readiness is the endpoint
 * that has asked PostgreSQL, Redis and the migration state, which is exactly the set of things a
 * scenario is about to depend on.
 */
const READY_TIMEOUT_MS = Number(process.env['E2E_READY_TIMEOUT_MS'] ?? 60_000);

/** Interval between probes. Not a wait for the application — a wait between two questions to it. */
const PROBE_INTERVAL_MS = 500;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const probe = async (url: string): Promise<{ ok: boolean; detail: string }> => {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });

    return { ok: response.ok, detail: `HTTP ${String(response.status)}: ${await response.text()}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
};

const globalSetup = async (): Promise<void> => {
  const url = `${apiURL}/ready`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'not probed';

  while (Date.now() < deadline) {
    const { ok, detail } = await probe(url);

    if (ok) return;

    last = detail;
    await pause(PROBE_INTERVAL_MS);
  }

  throw new Error(
    [
      `The stack at ${url} did not become ready within ${String(READY_TIMEOUT_MS)} ms.`,
      `Last answer: ${last}`,
      'Start it with `pnpm docker:up` and `pnpm dev`, or point E2E_API_URL at a running instance.',
    ].join('\n'),
  );
};

export default globalSetup;
