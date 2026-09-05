import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { zodFormResolver } from './zod-form-resolver.util.js';

/**
 * The resolver exists for one property, and it is the property Mantine's own cannot have.
 *
 * `schemaResolver` reads a schema through its Standard Schema face, where an issue carries a
 * `message` and a `path` and nothing else. A bound therefore cannot say «at most {{count}}» without
 * the number being written a second time, in the catalogue, in two languages — which is the shape
 * that had `teams.field.nameTooLong` promising 120 characters next to a schema free to say 200.
 *
 * Zod's own issue for a failed bound carries `maximum` / `minimum`. Reading it here means the
 * sentence interpolates the very number that refused the value: there is no second copy to drift.
 */
/**
 * Assembled rather than quoted, and for the reason its neighbour explains: `catalogue-parity` reads
 * every dotted literal under `src/` — this file included — as a key the interface asks for.
 */
const CAPACITY_KEY = ['employee', 'field', 'capacityTooLarge'].join('.');
const NESTED_PATH = ['owner', 'email'].join('.');
const SKILL_KEY = ['employee', 'field', 'skillTooLong'].join('.');
const MISMATCH_KEY = ['validation', 'password', 'mismatch'].join('.');

const schema = z.object({
  name: z.string().max(3, { error: 'teams.field.nameTooLong' }),
  reason: z.string().min(10, { error: 'permissions.field.reasonTooShort' }),
  hours: z.coerce.number({ error: 'validation.number.invalid' }).max(80, { error: CAPACITY_KEY }),
});

const resolve = zodFormResolver(schema);

describe('the issues a schema produced, as key and values', () => {
  it('answers with nothing when the values pass', () => {
    expect(resolve({ name: 'ok', reason: 'long enough reason', hours: '40' })).toEqual({});
  });

  it('carries the bound that refused the value, not a copy of it', () => {
    expect(resolve({ name: 'far too long', reason: 'long enough', hours: '40' })).toEqual({
      name: { key: 'teams.field.nameTooLong', values: { count: 3 } },
    });
  });

  it('carries a lower bound the same way', () => {
    expect(resolve({ name: 'ok', reason: 'short', hours: '40' })).toEqual({
      reason: { key: 'permissions.field.reasonTooShort', values: { count: 10 } },
    });
  });

  /**
   * A check Zod has no bound for — «every entry is short enough», where the entries share one
   * input — states its number in `params`, and it travels the same way. Without this a sentence
   * over a `refine` would be back to keeping the number in the catalogue, which is the whole thing
   * being removed.
   */
  it('carries the number a custom check declared in params', () => {
    const skills = zodFormResolver(
      z.object({
        skills: z.array(z.string()).refine((all) => all.every((one) => one.length <= 64), {
          error: SKILL_KEY,
          params: { count: 64 },
        }),
      }),
    );

    expect(skills({ skills: ['x'.repeat(65)] })).toEqual({
      skills: { key: SKILL_KEY, values: { count: 64 } },
    });
  });

  /** A custom check that declared no number — a cross-field equality — carries none either. */
  it('leaves a custom check without params valueless', () => {
    const matching = zodFormResolver(
      z
        .object({ a: z.string(), b: z.string() })
        .refine((values) => values.a === values.b, { error: MISMATCH_KEY, path: ['b'] }),
    );

    expect(matching({ a: 'x', b: 'y' })).toEqual({ b: { key: MISMATCH_KEY } });
  });

  /** A refusal with no number in it — a bad type — has no values to interpolate. */
  it('leaves a keyed issue without a bound valueless', () => {
    expect(resolve({ name: 'ok', reason: 'long enough reason', hours: 'x' })).toEqual({
      hours: { key: 'validation.number.invalid' },
    });
  });

  /**
   * CONTROL: a boundary whose `error` was forgotten still reaches a field — carrying Zod's own
   * English as its «key». That is the defect this whole change is about, and the resolver must not
   * hide it: `t` answers an unknown key with the key itself, so the sentence arrives untranslated
   * and the pseudo-locale gate sees it unmarked.
   */
  it('CONTROL: hands through the English of Zod when a bound declared no key', () => {
    const bare = zodFormResolver(z.object({ note: z.string().max(2) }));
    const issue = bare({ note: 'abc' })['note'];

    expect(issue?.key).toContain('Too big');
    expect(issue?.values).toEqual({ count: 2 });
  });

  it('keeps the first refusal per field and joins a nested path the way Mantine addresses it', () => {
    const nested = zodFormResolver(
      z.object({ owner: z.object({ email: z.string().min(1, { error: 'validation.required' }) }) }),
    );

    expect(nested({ owner: { email: '' } })).toEqual({
      [NESTED_PATH]: { key: 'validation.required', values: { count: 1 } },
    });
  });
});
