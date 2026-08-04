import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

import { reportClientError } from '@app/report-client-error.util.js';

/**
 * What leaves the browser when something breaks.
 *
 * This is the file where «the report carries no user content» stops being a promise and becomes an
 * assertion: the report is built from the error object and from nothing else, so there is no path
 * by which a field value, a token or an identifier could reach it. The generated contract type is
 * the second half of that guarantee — a field the specification does not declare fails to compile.
 *
 * The console line stays and is silenced here rather than asserted: a developer with the tab open
 * wants the real object, and a suite that let it through would print a stack per case.
 */
const sent = () => vi.spyOn(SharedApi, 'sendClientErrorReport').mockResolvedValue(undefined);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reporting a failure', () => {
  it('sends the message, the stack and the build that produced them', () => {
    const send = sent();
    const error = new Error('the card exploded');

    reportClientError(error, 'abc12345');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      message: 'the card exploded',
      reference: 'abc12345',
      appVersion: expect.any(String) as unknown as string,
      route: expect.any(String) as unknown as string,
    });
    expect(send.mock.calls[0]?.[0].stack).toContain('Error: the card exploded');
  });

  /**
   * A rejection is often not an `Error` — a string, an object, a `Response`. The report still has to
   * carry something readable rather than `[object Object]` in a field the schema requires.
   */
  it('describes a thrown value that is not an Error', () => {
    const send = sent();

    reportClientError('just a string', 'abc12345');

    expect(send.mock.calls[0]?.[0]).toMatchObject({ message: 'just a string' });
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('stack');
  });

  /**
   * The reporter is called from the query client too, where there is no boundary to make one up.
   * A report without a reference is still worth having — it just cannot be quoted back at support.
   */
  it('sends a placeholder when nothing gave it a reference', () => {
    const send = sent();

    reportClientError(new Error('from the data layer'));

    expect(send.mock.calls[0]?.[0].reference).toBe('unreferenced');
  });

  /**
   * The property that keeps one broken component from becoming two. A failed report — an
   * unreachable server, a 429 from the limiter, an offline tab — must not throw into the caller and
   * must not be reported in turn, which is how a loop starts.
   */
  it('swallows its own failure instead of raising a second one', () => {
    const send = vi
      .spyOn(SharedApi, 'sendClientErrorReport')
      .mockRejectedValue(new Error('the collector is down'));

    expect(() => {
      reportClientError(new Error('the original failure'), 'abc12345');
    }).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  /**
   * CONTROL: the assertions above are about what the report *contains*. This one is about what it
   * cannot contain — the report is assembled from a closed set of fields, so a property the schema
   * never declared is absent whatever the error object happens to be carrying.
   */
  it('CONTROL: sends only the fields the contract declares', () => {
    const send = sent();
    const error = Object.assign(new Error('leaky'), {
      password: 'example-only-not-a-real-password',
      token: 'example-only-not-a-real-token',
    });

    reportClientError(error, 'abc12345');

    expect(Object.keys(send.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'appVersion',
      'message',
      'reference',
      'route',
      'stack',
    ]);
  });
});
