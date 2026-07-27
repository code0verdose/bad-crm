import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SESSION_STATUSES } from '@units/session/model';
import { useSessionStatus } from '@units/session/service';

describe('useSessionStatus', () => {
  it('reports a status from the closed set of session states', () => {
    const { result } = renderHook(() => useSessionStatus());

    expect(SESSION_STATUSES).toContain(result.current.status);
  });

  /**
   * Before anything has been asked of the API, `unknown` is the honest answer. Asserting it keeps
   * the day this hook starts calling a query honest too: the first render still has to be
   * `unknown`, or the UI flashes a login screen at a signed-in user on every reload.
   */
  it('starts as unknown rather than guessing that nobody is signed in', () => {
    const { result } = renderHook(() => useSessionStatus());

    expect(result.current).toEqual({ status: 'unknown' });
  });
});
