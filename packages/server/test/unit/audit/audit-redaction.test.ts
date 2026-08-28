/**
 * @vitest-environment node
 *
 * What may not reach `before`/`after`, decided by the writer rather than by every caller.
 *
 * The rule the trail has to hold is in `rules/observability.mdc` §16 and in the doc comment of
 * `audit-logger.port.ts`: identifiers, statuses and masks go in, secrets do not. Until now that was
 * a sentence, and the property it describes was held by whoever wrote each of the call sites — a
 * property nothing checked and nothing would notice losing.
 *
 * The two halves of this file are the two ways it can be wrong. A secret that survives is the leak;
 * a legitimate value that does not survive is the trail quietly losing the answer it exists to give
 * («what were the role's permissions before?»), which is why the keeps below are as load-bearing as
 * the cuts.
 */
import { describe, expect, it } from 'vitest';

import {
  AUDIT_REDACTED_FIELDS_KEY,
  AUDIT_REDACTION_MARKER,
  redactAuditPayload,
} from '@/application/platform/audit/audit-redaction.util.js';

const redactedPaths = (payload: Record<string, unknown>): readonly string[] => {
  const paths = redactAuditPayload(payload)?.[AUDIT_REDACTED_FIELDS_KEY];

  return Array.isArray(paths) ? (paths as readonly string[]) : [];
};

/**
 * Cut by the **name** of the field, when the value could carry key material.
 *
 * A name is a weak signal on its own, which is why it is paired with the shape of the value: a
 * count of deleted recovery codes and the recovery codes themselves differ by type, not by name,
 * and only one of them is a secret.
 */
const cutByName = [
  { name: 'a password', payload: { password: 'hunter2' }, path: 'password' },
  {
    name: 'a password hash',
    payload: { passwordHash: '$argon2id$v=19$m=1' },
    path: 'passwordHash',
  },
  { name: 'a refresh token', payload: { refreshToken: 'opaque-value' }, path: 'refreshToken' },
  { name: 'an encrypted column', payload: { totpSecretEnc: 'v1:a:b:c' }, path: 'totpSecretEnc' },
  { name: 'an api key', payload: { apiKey: 'sk-live-1' }, path: 'apiKey' },
  {
    name: 'a list of recovery codes',
    payload: { recoveryCodes: ['aa', 'bb'] },
    path: 'recoveryCodes',
  },
  { name: 'a passphrase', payload: { passphrase: 'correct horse' }, path: 'passphrase' },
  { name: 'a credential bag', payload: { credentials: { user: 'a' } }, path: 'credentials' },
  { name: 'a nested secret', payload: { smtp: { secret: 'x' } }, path: 'smtp.secret' },
  {
    name: 'a secret inside an array',
    payload: { hosts: [{ token: 't' }] },
    path: 'hosts[0].token',
  },
] as const;

describe('a field whose name says it may carry key material', () => {
  it.each(cutByName)('cuts $name', ({ payload, path }) => {
    expect(redactedPaths(payload)).toStrictEqual([path]);
  });

  it('leaves the marker in place of the value rather than dropping the field', () => {
    expect(redactAuditPayload({ password: 'hunter2' })).toStrictEqual({
      password: AUDIT_REDACTION_MARKER,
      [AUDIT_REDACTED_FIELDS_KEY]: ['password'],
    });
  });
});

/**
 * Cut by the **shape** of the value, whatever it is called.
 *
 * The name-based half only knows the names somebody thought of. This half is what catches the
 * credential filed under an innocent name — a presigned URL in `url`, a token in `value` — which is
 * exactly how a secret reaches a trail in practice: nobody calls the field `password`.
 */
const cutByShape = [
  {
    name: 'a presigned url',
    payload: { url: 'https://s3.local/f?X-Amz-Signature=abc&X-Amz-Credential=k' },
    path: 'url',
  },
  {
    name: 'an argon2 digest',
    payload: { value: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' },
    path: 'value',
  },
  {
    name: 'a jwt',
    payload: {
      // Assembled from its three parts rather than written out: a literal of this shape is what the
      // repository's secret scanner exists to catch, and a fixture that trips it is how people
      // learn to pass `--no-verify`. The value the guard sees is identical either way.
      note: [
        'eyJhbGciOiJIUzI1NiJ9',
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
        'dBjftJeZ4CVPmB92K27uhbUJU1p1r',
      ].join('.'),
    },
    path: 'note',
  },
  { name: 'the encryption envelope', payload: { blob: 'v1:aXY=:dGFn:Y2lwaGVy' }, path: 'blob' },
  {
    name: 'an opaque high-entropy blob',
    payload: { blob: 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5d2FsZG8' },
    path: 'blob',
  },
] as const;

describe('a value whose shape says it is a credential', () => {
  it.each(cutByShape)('cuts $name', ({ payload, path }) => {
    expect(redactedPaths(payload)).toStrictEqual([path]);
  });
});

/**
 * What the trail is for. Every one of these appears in a payload this repository ships today
 * (`grep -rhA8 'audit\.record(' packages/server/src/application`), and a rule that cut any of them
 * would be answering «what changed?» with «something».
 */
const kept = [
  { name: 'a count of deleted recovery codes', payload: { recoveryCodesDeleted: 8 } },
  { name: 'a flag that a second factor was on', payload: { totpEnabled: true } },
  {
    name: 'the full permission set of a role',
    payload: { permissions: ['task:read', 'task:update'] },
  },
  { name: 'a role key', payload: { key: 'project-manager', name: 'Project manager' } },
  { name: 'an invited address', payload: { email: 'lead@example.com' } },
  { name: 'an identifier', payload: { roleId: '00000000-0000-4000-8000-000000000c01' } },
  { name: 'a written reason', payload: { reason: 'temporary access for the incident on friday' } },
  { name: 'a kind of second factor', payload: { secondFactorKind: 'TOTP' } },
  { name: 'nothing at all', payload: {} },
] as const;

describe('a value the trail exists to keep', () => {
  it.each(kept)('keeps $name', ({ payload }) => {
    expect(redactAuditPayload(payload)).toStrictEqual(payload);
  });

  it('adds no marker key when nothing was cut', () => {
    expect(redactAuditPayload({ totpEnabled: true })).not.toHaveProperty(AUDIT_REDACTED_FIELDS_KEY);
  });

  it('passes «nothing to record» through unchanged', () => {
    expect(redactAuditPayload(undefined)).toBeUndefined();
  });
});

/**
 * The writer may not become a reason the action was not written down.
 *
 * A self-hosted installation has nobody on call: an exception thrown here would roll back the
 * transaction of the change itself, so a payload the walker cannot make sense of is redacted whole
 * and the row is still written. Fail closed on the content, fail open on the record.
 */
describe('a payload the walker cannot handle', () => {
  it('redacts a structure deeper than the walker goes instead of descending forever', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'value' } } } } } } };

    expect(redactedPaths(deep)).toStrictEqual(['a.b.c.d.e.f']);
  });

  it('survives a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'role' };
    cyclic['self'] = cyclic;

    expect(() => redactAuditPayload(cyclic)).not.toThrow();
    expect(redactAuditPayload(cyclic)?.['name']).toBe('role');
  });

  it('redacts everything and throws nothing when reading the payload fails', () => {
    const hostile = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get: () => {
        throw new Error('nope');
      },
    });

    expect(redactAuditPayload(hostile)).toStrictEqual({
      [AUDIT_REDACTED_FIELDS_KEY]: ['*'],
    });
  });
});
