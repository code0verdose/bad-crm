import { describe, expect, it } from 'vitest';

import { describeAuditWriteFailure } from '@/infrastructure/logging/audit-write-failure.util.js';

/**
 * The shape of the failure on the `audit.write_degraded` line: fixed here, so «no payload on the
 * line» is a property of the code and not of which error the store happened to throw.
 */
describe('describing the failure behind a degraded audit write', () => {
  it('reads the type, the message and both codes of a driver error', () => {
    const failure = Object.assign(new Error('Unsupported Unicode escape sequence'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: { code: '22P05', message: 'unsupported Unicode escape sequence' },
    });

    expect(describeAuditWriteFailure(failure)).toStrictEqual({
      type: 'PrismaClientKnownRequestError',
      message: 'Unsupported Unicode escape sequence',
      code: 'P2010',
      driverCode: '22P05',
    });
  });

  it('writes no code fields at all when the error carries none', () => {
    expect(describeAuditWriteFailure(new RangeError('out of range'))).toStrictEqual({
      type: 'RangeError',
      message: 'out of range',
    });
  });

  it('keeps only the first non-empty line, cut to two hundred characters', () => {
    const long = `\n\n  ${'x'.repeat(300)}\n{ data: { after: { secret: 'value' } } }`;

    const described = describeAuditWriteFailure(new Error(long));

    expect(described.message).toBe('x'.repeat(200));
    expect(JSON.stringify(described)).not.toContain('secret');
  });

  it('ignores a code that is not a string, so a numeric errno cannot masquerade as one', () => {
    const failure = Object.assign(new Error('boom'), { code: 42, meta: 'not-an-object' });

    expect(describeAuditWriteFailure(failure)).toStrictEqual({ type: 'Error', message: 'boom' });
  });

  it('survives a value thrown instead of an Error', () => {
    expect(describeAuditWriteFailure('just a string\nsecond line')).toStrictEqual({
      type: 'non-error',
      message: 'just a string',
    });
  });
});
