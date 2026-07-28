import { describe, expect, it } from 'vitest';

import { SharedConfig } from '@shared';
import { $api, apiClient, createApiClient } from '@shared/api';

import { API_BASE_URL } from './test-api.util.js';

/**
 * The typed client is the only door to the API (`rules/api-contract.mdc` §3). What is asserted here
 * is the part a type cannot: that the door is actually configured — base URL, credentials, and a
 * cancellation signal that reaches the transport.
 */
const meta = (): Response =>
  new Response(JSON.stringify({ apiVersion: 'v1', serverTime: '2026-07-27T09:41:12.004Z' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('the configured client', () => {
  it('prefixes every call with the API base URL of this installation', async () => {
    const seen: string[] = [];
    const client = createApiClient({
      baseUrl: API_BASE_URL,
      fetch: (request: Request) => {
        seen.push(new URL(request.url).pathname);
        return Promise.resolve(meta());
      },
    });

    await client.GET('/meta');

    expect(seen).toEqual(['/api/v1/meta']);
  });

  /**
   * The refresh token lives in an httpOnly cookie scoped to `/api/v1/auth`, so the browser has to be
   * told to attach credentials — otherwise a deployment that serves the SPA from a different origin
   * silently loses the ability to refresh, and every session ends after fifteen minutes.
   */
  it('sends credentials, because the refresh cookie is what keeps a session alive', async () => {
    let credentials: RequestCredentials | undefined;
    const client = createApiClient({
      baseUrl: API_BASE_URL,
      fetch: (request: Request) => {
        credentials = request.credentials;
        return Promise.resolve(meta());
      },
    });

    await client.GET('/meta');

    expect(credentials).toBe('include');
  });

  it('is instantiated once for the application, against the validated environment', () => {
    expect(typeof apiClient.GET).toBe('function');
    expect(SharedConfig.clientEnv.VITE_API_BASE_URL).toBe('/api/v1');
  });

  it('exposes the TanStack Query bindings the service layer builds its hooks on', () => {
    expect(typeof $api.useQuery).toBe('function');
    expect(typeof $api.useMutation).toBe('function');
  });
});

/**
 * `rules/tanstack-query.mdc` §4: the signal a query function receives has to reach the transport,
 * or a filter change leaves the previous request running and its late answer overwrites the fresh
 * one. The counter below is the observable form of that requirement.
 */
describe('cancellation', () => {
  it('aborts the in-flight request when the caller cancels', async () => {
    let aborts = 0;
    const client = createApiClient({
      baseUrl: API_BASE_URL,
      fetch: (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            aborts += 1;
            reject(request.signal.reason as Error);
          });
        }),
    });

    const controller = new AbortController();
    const inFlight = client.GET('/meta', { signal: controller.signal });
    controller.abort();

    await expect(inFlight).rejects.toBeTruthy();
    expect(aborts).toBe(1);
  });

  it('leaves an uncancelled request alone', async () => {
    let aborts = 0;
    const client = createApiClient({
      baseUrl: API_BASE_URL,
      fetch: (request: Request) => {
        request.signal.addEventListener('abort', () => {
          aborts += 1;
        });
        return Promise.resolve(meta());
      },
    });

    const controller = new AbortController();
    await client.GET('/meta', { signal: controller.signal });

    expect(aborts).toBe(0);
  });
});
