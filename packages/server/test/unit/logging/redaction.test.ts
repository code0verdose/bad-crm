import { describe, expect, it } from 'vitest';

import {
  REDACTED_PATHS,
  REDACTED_PLACEHOLDER,
} from '../../../src/infrastructure/logging/log-redaction.constant.js';
import { serializeLogError } from '../../../src/infrastructure/logging/log-error.serializer.js';
import { createRootLogger } from '../../../src/infrastructure/logging/pino-logger.adapter.js';

/** Collects the JSON lines pino writes, so assertions run against the real serialized output. */
const capturingDestination = (): { write: (line: string) => void; lines: () => string[] } => {
  const written: string[] = [];

  return { write: (line) => written.push(line), lines: () => written };
};

const loggerWritingTo = (destination: { write: (line: string) => void }) =>
  createRootLogger({ level: 'debug', version: '0.0.0' }, destination);

describe('secret redaction', () => {
  /**
   * The list is the one in CLAUDE.md, «Что нельзя логировать никогда». Each case is a value that
   * has appeared in a real incident report of some project: an Authorization header logged with
   * the request, a password echoed back inside a validation error, an integration key attached to
   * an HTTP client error.
   */
  it.each([
    ['req.headers.authorization', { req: { headers: { authorization: 'Bearer s3cr3t-token' } } }],
    ['req.headers.cookie', { req: { headers: { cookie: 'session=s3cr3t-token' } } }],
    ['res.headers["set-cookie"]', { res: { headers: { 'set-cookie': 's3cr3t-token' } } }],
    ['password', { body: { password: 's3cr3t-token' } }],
    ['token', { session: { token: 's3cr3t-token' } }],
    ['refreshToken', { session: { refreshToken: 's3cr3t-token' } }],
    ['apiKey', { provider: { apiKey: 's3cr3t-token' } }],
    ['apiKeyEnc', { provider: { apiKeyEnc: 's3cr3t-token' } }],
    ['secret', { webhook: { secret: 's3cr3t-token' } }],
    ['otp', { auth: { otp: 's3cr3t-token' } }],
    ['recoveryCode', { auth: { recoveryCode: 's3cr3t-token' } }],
  ])('replaces %s with the placeholder', (_path, payload) => {
    const destination = capturingDestination();

    loggerWritingTo(destination).info(payload, 'sensitive');

    const line = destination.lines().join('\n');

    expect(line).not.toContain('s3cr3t-token');
    expect(line).toContain(REDACTED_PLACEHOLDER);
  });

  it('keeps the surrounding fields, so a redacted line is still worth reading', () => {
    const destination = capturingDestination();

    loggerWritingTo(destination).info(
      { userId: '01J8Z2F5Q3K9V6N0R4T7YB3XQD', body: { password: 's3cr3t-token' } },
      'login attempt',
    );

    const entry = JSON.parse(destination.lines()[0] ?? '{}') as {
      userId?: string;
      body?: { password?: string };
      msg?: string;
    };

    expect(entry.userId).toBe('01J8Z2F5Q3K9V6N0R4T7YB3XQD');
    expect(entry.body?.password).toBe(REDACTED_PLACEHOLDER);
    expect(entry.msg).toBe('login attempt');
  });

  it('declares every path CLAUDE.md requires, so a new secret key is a visible diff', () => {
    expect(REDACTED_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.refreshToken',
        '*.apiKey',
        '*.apiKeyEnc',
        '*.secret',
        '*.otp',
        '*.recoveryCode',
      ]),
    );
  });
});

describe('error serializer', () => {
  /**
   * An HTTP client attaches its request config to the error it throws, and that config carries the
   * Authorization header of the integration. Logged with the stack trace, the token travels into
   * every log aggregator — this is the path by which integration keys leak most often, and `redact`
   * does not catch it because the header sits under an arbitrary `config.headers` object.
   */
  it('strips config.headers from an HTTP client error', () => {
    const error = Object.assign(new Error('Request failed with status code 401'), {
      config: {
        url: 'https://api.example.com/v1/models',
        method: 'POST',
        headers: { authorization: 'Bearer integration-key' },
      },
    });

    const serialized = serializeLogError(error);

    expect(JSON.stringify(serialized)).not.toContain('integration-key');
    expect(serialized.message).toBe('Request failed with status code 401');
  });

  it('keeps the parts of the request that help debugging', () => {
    const error = Object.assign(new Error('boom'), {
      config: { url: 'https://api.example.com/v1/models', method: 'POST', headers: {} },
    });

    const serialized = serializeLogError(error) as { config?: { url?: string; method?: string } };

    expect(serialized.config?.url).toBe('https://api.example.com/v1/models');
    expect(serialized.config?.method).toBe('POST');
  });

  it('serializes an ordinary error with its type, message and stack', () => {
    const serialized = serializeLogError(new TypeError('not a function'));

    expect(serialized.type).toBe('TypeError');
    expect(serialized.message).toBe('not a function');
    expect(serialized.stack).toContain('redaction.test.ts');
  });

  it.each([
    ['a string', 'just a string', 'just a string'],
    ['an object', { reason: 'rejected' }, '{"reason":"rejected"}'],
  ])('survives %s thrown instead of an Error', (_label, thrown, expected) => {
    // `Promise.reject('nope')` and `throw { code: 1 }` are both legal and both reach the logger.
    expect(serializeLogError(thrown)).toMatchObject({ message: expected });
  });
});
