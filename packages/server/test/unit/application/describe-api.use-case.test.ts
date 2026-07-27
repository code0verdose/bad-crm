import { describe, expect, it } from 'vitest';

import { DescribeApiUseCase } from '@/application/platform/use-cases/describe-api.use-case.js';

const clockAt = (iso: string): { now: () => Date } => ({ now: () => new Date(iso) });

describe('describing the API surface', () => {
  it('reports the version it was wired with, so the prefix is decided in one place', async () => {
    const useCase = new DescribeApiUseCase(clockAt('2026-07-27T10:00:00.000Z'), 'v1');

    await expect(useCase.execute()).resolves.toMatchObject({ apiVersion: 'v1' });
  });

  /**
   * Through `ClockPort` rather than `new Date()`: a use-case that reads the wall clock directly
   * cannot be tested without freezing global time, and every later scheduling rule in this product
   * inherits whichever habit is established here (rules/testing.mdc §12).
   */
  it('reads the time through the clock port', async () => {
    const useCase = new DescribeApiUseCase(clockAt('2026-07-27T10:00:00.000Z'), 'v1');

    const result = await useCase.execute();

    expect(result.serverTime.toISOString()).toBe('2026-07-27T10:00:00.000Z');
  });
});
