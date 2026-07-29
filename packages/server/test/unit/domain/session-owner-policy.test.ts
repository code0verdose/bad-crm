import { describe, expect, it } from 'vitest';

import { requireSessionOwner } from '@/domain/identity/access/session-owner.policy.js';
import { AppError } from '@/domain/shared/errors/app.errors.js';

const OWNER = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const STRANGER = '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4';
const SESSION = {
  id: '4f1c2f4a-0a6d-4a7b-9a1e-2d3c4b5a6f70',
  userId: OWNER,
  familyId: 'f0f0f0f0-0000-4000-8000-000000000001',
};

const refusal = (session: typeof SESSION | null, caller: string): AppError => {
  try {
    requireSessionOwner(session, caller);
  } catch (error) {
    return error as AppError;
  }

  throw new Error('expected the policy to refuse');
};

describe('acting on a session row', () => {
  it('lets the owner through and hands the row back', () => {
    expect(requireSessionOwner(SESSION, OWNER)).toBe(SESSION);
  });

  /**
   * The acceptance criterion of STORY-006-04, and the reason this is a policy rather than an `if`
   * in a controller: 403 would confirm that the id is real and belongs to somebody else, over a
   * resource whose ids are handed out in a list and rotate on every refresh.
   */
  it('answers 404 for a stranger, not 403', () => {
    const error = refusal(SESSION, STRANGER);

    expect(error.code).toBe('session_not_found');
    expect(error.status).toBe(404);
  });

  it('answers exactly the same for an id that does not exist', () => {
    const missing = refusal(null, OWNER);
    const stranger = refusal(SESSION, STRANGER);

    expect(missing.code).toBe(stranger.code);
    expect(missing.status).toBe(stranger.status);
    expect(missing.message).toBe(stranger.message);
  });
});
