import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedHooks } from '@shared';

/**
 * The countdown behind the second-factor step, on a clock the test owns.
 *
 * Two properties matter and neither is visible from a single render: that it counts *down* rather
 * than reporting the same number forever, and that it renders zero exactly once before it stops —
 * the render the caller acts on. A hook that stopped ticking one beat early would freeze the screen
 * at «1 s» and leave a dead step on it, which is the failure this file exists to refuse.
 *
 * **Every deadline below is computed before `renderHook`, never inside it.** The render callback
 * runs again on every tick, so `renderHook(() => useSecondsRemaining(Date.now() + 5_000))` moves
 * the deadline forward by exactly as much as the clock advanced and reports the same number for
 * ever — a passing-looking countdown that never counts. That is a mistake in the test rather than
 * in the hook, and it is the first thing this file got wrong.
 */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the seconds left before a deadline', () => {
  it('reports nothing when there is no deadline to count to', () => {
    const { result } = renderHook(() => SharedHooks.useSecondsRemaining(null));

    expect(result.current).toBeNull();
  });

  it('reports the whole seconds between now and the deadline', () => {
    const deadline = Date.now() + 300 * 1_000;

    const { result } = renderHook(() => SharedHooks.useSecondsRemaining(deadline));

    expect(result.current).toBe(300);
  });

  it('counts down as the clock advances', () => {
    const deadline = Date.now() + 5 * 1_000;

    const { result } = renderHook(() => SharedHooks.useSecondsRemaining(deadline));

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(4);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(2);
  });

  it('lands on zero once the deadline has passed, rather than stopping above it', () => {
    const deadline = Date.now() + 2_500;

    const { result } = renderHook(() => SharedHooks.useSecondsRemaining(deadline));

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(result.current).toBe(0);
  });

  /**
   * A deadline already in the past is zero on the first render — the step it belongs to is over
   * before it is drawn, and nothing has to tick for the caller to find out.
   */
  it('reports zero for a deadline that has already passed', () => {
    const deadline = Date.now() - 1_000;

    const { result } = renderHook(() => SharedHooks.useSecondsRemaining(deadline));

    expect(result.current).toBe(0);
  });

  it('stays at zero afterwards rather than counting into negative numbers', () => {
    const deadline = Date.now() + 1_000;

    const { result } = renderHook(() => SharedHooks.useSecondsRemaining(deadline));

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(result.current).toBe(0);
  });
});
