import { describe, expect, it } from 'vitest';

import {
  asOrganizationId,
  asProjectId,
  asTaskId,
  asUserId,
  organizationIdSchema,
  taskIdSchema,
} from '../../src/validation/index.js';
import type { OrganizationId, TaskId, UserId } from '../../src/types/index.js';

const UUID_A = '018f7c2e-9b6a-7c31-8f1e-2b0d5a6c9e11';
const UUID_B = '018f7c2e-9b6a-7c31-8f1e-2b0d5a6c9e22';

describe('branded id schemas', () => {
  it('parses a UUID and returns the same string value at runtime', () => {
    expect(organizationIdSchema.parse(UUID_A)).toBe(UUID_A);
  });

  it.each(['not-a-uuid', '', UUID_A.toUpperCase().replace(/-/g, ''), 42])(
    'rejects %o at runtime',
    (value) => {
      expect(organizationIdSchema.safeParse(value).success).toBe(false);
    },
  );

  const FACTORIES: readonly (readonly [string, (value: string) => string])[] = [
    ['asOrganizationId', asOrganizationId],
    ['asUserId', asUserId],
    ['asProjectId', asProjectId],
    ['asTaskId', asTaskId],
  ];

  it.each(FACTORIES)('%s throws on a value that is not a UUID', (_name, factory) => {
    expect(() => factory('nope')).toThrow();
    expect(factory(UUID_A)).toBe(UUID_A);
  });
});

/**
 * The whole point of branding: two ids that are both strings at runtime must not be
 * interchangeable at compile time. `@ts-expect-error` fails the build when the error disappears,
 * so these assertions only hold while `pnpm typecheck` covers this folder.
 */
describe('branded id types', () => {
  const organizationId: OrganizationId = asOrganizationId(UUID_A);
  const userId: UserId = asUserId(UUID_B);

  const takesUserId = (value: UserId): string => value;
  const takesTaskId = (value: TaskId): string => value;

  it('accepts the matching brand', () => {
    expect(takesUserId(userId)).toBe(UUID_B);
  });

  it('rejects a different brand and a bare string', () => {
    // @ts-expect-error an OrganizationId is not a UserId
    expect(takesUserId(organizationId)).toBe(UUID_A);
    // @ts-expect-error a bare string is not a UserId
    expect(takesUserId(UUID_B)).toBe(UUID_B);
    // @ts-expect-error a UserId is not a TaskId
    expect(takesTaskId(userId)).toBe(UUID_B);
  });

  it('infers the branded type from the schema, not from a hand-written alias', () => {
    const parsed = taskIdSchema.parse(UUID_A);
    const asTask: TaskId = parsed;

    expect(asTask).toBe(UUID_A);
  });
});
