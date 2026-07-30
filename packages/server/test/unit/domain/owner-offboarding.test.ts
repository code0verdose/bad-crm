import { describe, expect, it } from 'vitest';

import { requireOwnershipTransferredBeforeOffboarding } from '@/domain/identity/access/owner-offboarding.policy.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/**
 * The invariant the schema cannot express, and the reason it is written before the operation exists.
 *
 * `organizations.owner_id` is NOT NULL with `ON DELETE NO ACTION`, so PostgreSQL refuses to delete the
 * owner outright. A soft delete is not a delete — the row stays, the key never fires — so «the
 * organization has an owner» stays true while nobody can administer it. That half is application-side,
 * and offboarding (STORY-012-05) has to meet it.
 */
const OWNER = '018f4a3b-0000-7000-8000-000000000001';
const MEMBER = '018f4a3b-0000-7000-8000-000000000002';

describe('offboarding an account', () => {
  it('CONTROL: lets an ordinary member go', () => {
    expect(() =>
      requireOwnershipTransferredBeforeOffboarding({
        userId: MEMBER,
        organizationOwnerId: OWNER,
      }),
    ).not.toThrow();
  });

  it('refuses the owner, and says which step is missing', () => {
    const failure = (() => {
      try {
        requireOwnershipTransferredBeforeOffboarding({
          userId: OWNER,
          organizationOwnerId: OWNER,
        });

        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(ConflictError);
    expect(failure).toMatchObject({
      code: 'last_owner_required',
      status: 409,
    });
  });

  /**
   * A conflict rather than a denial, asserted because the difference is what the caller does next.
   *
   * `403` would say «you may not do this», and the caller would stop; `404` would say the subject does
   * not exist, and the caller would believe it. Neither is true — the account is there, the caller is
   * allowed to offboard people, and one specific action makes the request satisfiable. `409` is the
   * status that means exactly that.
   */
  it('is not an authorization failure, because nothing here is about permission', () => {
    const failure = (() => {
      try {
        requireOwnershipTransferredBeforeOffboarding({ userId: OWNER, organizationOwnerId: OWNER });

        return undefined;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect((failure as { status: number }).status).not.toBe(403);
    expect((failure as { status: number }).status).not.toBe(404);
  });
});
