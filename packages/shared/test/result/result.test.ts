import { describe, expect, it } from 'vitest';

import { err, isErr, isOk, mapResult, ok, unwrapOr } from '../../src/result/index.js';
import type { Result } from '../../src/result/index.js';

const success: Result<number, string> = ok(2);
const failure: Result<number, string> = err('boom');

describe('Result', () => {
  it('carries a value on the ok branch and an error on the err branch', () => {
    expect(success).toEqual({ ok: true, value: 2 });
    expect(failure).toEqual({ ok: false, error: 'boom' });
  });

  it('narrows through the discriminant', () => {
    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isOk(failure)).toBe(false);
    expect(isErr(failure)).toBe(true);
  });

  it('maps only the ok branch and leaves the error untouched', () => {
    expect(mapResult(success, (value) => value * 3)).toEqual({ ok: true, value: 6 });
    expect(mapResult(failure, (value) => value * 3)).toEqual({ ok: false, error: 'boom' });
  });

  it('falls back to the default only on the err branch', () => {
    expect(unwrapOr(success, 99)).toBe(2);
    expect(unwrapOr(failure, 99)).toBe(99);
  });

  it('gives the compiler the value only inside the ok branch', () => {
    const read = (result: Result<number, string>): number => (isOk(result) ? result.value : -1);

    expect(read(success)).toBe(2);
    expect(read(failure)).toBe(-1);
    // @ts-expect-error the ok branch carries no `error` member
    expect(ok(2).error).toBeUndefined();
  });
});
