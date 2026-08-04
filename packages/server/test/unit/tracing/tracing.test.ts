import { context, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { createRootLogger } from '../../../src/infrastructure/logging/pino-logger.adapter.js';

import {
  DEFAULT_DEV_SAMPLE_RATIO,
  DEFAULT_PRODUCTION_SAMPLE_RATIO,
  resolveSampleRatio,
  startTracing,
} from '../../../src/infrastructure/tracing/tracing.factory.js';

/**
 * Tracing is the one subsystem in this epic that must be **absent** by default rather than merely
 * quiet: it patches `http`, `express`, Prisma and `ioredis` at import time, keeps a span per request
 * in memory and opens a connection to a collector. A small installation asked for none of that, and
 * «started but exporting nowhere» still pays for all of it.
 */
describe('starting the SDK', () => {
  it('does not start without a collector to export to', () => {
    expect(startTracing({ endpoint: undefined, environment: 'production', version: '0.0.0' })).toBe(
      undefined,
    );
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('treats %s as no collector at all', (_case, endpoint) => {
    expect(startTracing({ endpoint, environment: 'production', version: '0.0.0' })).toBe(undefined);
  });

  /**
   * CONTROL: the guard above must be about the endpoint and nothing else — a `startTracing` that
   * returned `undefined` unconditionally would satisfy every case above and trace nothing, ever.
   */
  it('CONTROL: starts when there is somewhere to export to', async () => {
    const started = startTracing({
      endpoint: 'http://localhost:4318',
      environment: 'test',
      version: '0.0.0',
    });

    expect(started).not.toBe(undefined);

    await started?.shutdown();
  });
});

/**
 * Sampling is the difference between a trace budget and an outage. 100 % in development, because a
 * developer wants the request they just made; a tenth in production, because a self-hosted
 * installation pays for the collector it runs.
 */
describe('the sample ratio', () => {
  it.each([
    ['development', DEFAULT_DEV_SAMPLE_RATIO],
    ['test', DEFAULT_DEV_SAMPLE_RATIO],
    ['production', DEFAULT_PRODUCTION_SAMPLE_RATIO],
  ])('defaults to the right value in %s', (environment, expected) => {
    expect(resolveSampleRatio({ environment, configured: undefined })).toBe(expected);
  });

  it('lets an operator override it', () => {
    expect(resolveSampleRatio({ environment: 'production', configured: 0.5 })).toBe(0.5);
  });

  it.each([
    ['zero, which switches sampling off entirely', 0, 0],
    ['one, which keeps everything', 1, 1],
  ])('accepts %s', (_case, configured, expected) => {
    expect(resolveSampleRatio({ environment: 'production', configured })).toBe(expected);
  });

  /**
   * A ratio outside `[0, 1]` is a typo — `10` meaning «ten percent» is the one somebody actually
   * makes. Clamped rather than thrown: refusing to start over a sampling rate would take an
   * installation down for a setting that has an obvious safe reading.
   */
  it.each([
    ['above one', 10, 1],
    ['below zero', -1, 0],
  ])('clamps a ratio %s instead of refusing to start', (_case, configured, expected) => {
    expect(resolveSampleRatio({ environment: 'production', configured })).toBe(expected);
  });
});

/**
 * The link between a log line and a trace, in the direction that matters: an operator reading a log
 * has an identifier they can paste into a trace viewer. Without it the two systems describe the same
 * request and neither says so.
 */
describe('log lines and traces', () => {
  it('carries no traceId when nothing is being traced', () => {
    const written: string[] = [];

    createRootLogger({ level: 'info', version: '0.0.0' }, { write: (l) => written.push(l) }).info(
      'no span here',
    );

    expect(JSON.parse(written[0] ?? '{}')).not.toHaveProperty('traceId');
  });

  it('carries a traceId when a span is active', () => {
    const written: string[] = [];
    const logger = createRootLogger(
      { level: 'info', version: '0.0.0' },
      { write: (l) => written.push(l) },
    );

    const span = trace.getTracer('test').startSpan('unit-of-work');
    context.with(trace.setSpan(context.active(), span), () => {
      logger.info('inside a span');
    });
    span.end();

    // The **presence** of the field is the assertion, not its value: with no SDK registered the API
    // hands back a non-recording span whose id is all zeros, and pinning that value would be
    // asserting a detail of the no-op implementation rather than the behaviour under test. The case
    // above proves the field is absent when nothing is active, so presence here means the mixin
    // read the span rather than always adding a key.
    expect(JSON.parse(written[0] ?? '{}')).toHaveProperty('traceId');
  });
});
