/**
 * `fetch` with a deadline. Node's global `fetch` has no timeout of its own, and a MinIO container
 * that accepted the connection but never answers would otherwise hang the check indefinitely.
 */

const withDeadline = async <T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

export const headStatus = async (
  request: { url: URL; headers: Record<string, string> },
  timeoutMs: number,
): Promise<number> =>
  withDeadline(timeoutMs, async (signal) => {
    const response = await fetch(request.url, {
      method: 'HEAD',
      headers: request.headers,
      signal,
    });

    return response.status;
  });

export const getText = async (
  url: URL,
  timeoutMs: number,
): Promise<{ status: number; body: string }> =>
  withDeadline(timeoutMs, async (signal) => {
    const response = await fetch(url, { signal });

    return { status: response.status, body: await response.text() };
  });
