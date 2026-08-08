import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { type Actor } from '@/domain/access/actor.types.js';
import {
  assertTransferable,
  type TransferRecipient,
} from '@/domain/iam/access/ownership-transfer.policy.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/**
 * Whether an organization may change hands, and to this person — the table `assertTransferable`
 * exists to answer, table-driven per `rules/testing.mdc`, 2 (100 % of a policy's branches).
 *
 * The case worth the most attention is not in the taxonomy the docstring on the policy already
 * names (self-transfer, a suspended recipient): it is that holding `organization:transfer_ownership`
 * is not the same fact as being `organizations.owner_id`, and a delegate who has the one without the
 * other must be refused *before* either of the other two checks runs — including when the delegate
 * names the organization's real owner as recipient, which is not a way to launder the operation.
 */

const OWNER = '018f4a3b-0000-7000-8000-0000000000b1';
const DELEGATE = '018f4a3b-0000-7000-8000-0000000000b2';
const HEIR = '018f4a3b-0000-7000-8000-0000000000b3';

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: OWNER,
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['organization:transfer_ownership']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const recipient = (overrides: Partial<TransferRecipient> = {}): TransferRecipient => ({
  userId: HEIR,
  status: 'ACTIVE',
  ...overrides,
});

const thrown = (fn: () => void): unknown => {
  try {
    fn();

    return undefined;
  } catch (error) {
    return error;
  }
};

describe('handing the organization to somebody else', () => {
  it('CONTROL: allows the owner to hand it to an active account', () => {
    expect(() => assertTransferable(actorWith(), OWNER, recipient())).not.toThrow();
  });

  /**
   * The gap this table exists to close. `organization:transfer_ownership` reaching a delegate is a
   * real, supported shape — a per-user ALLOW override, a custom role, «stand in for me while I am on
   * leave» — and the guard has no way to tell that apart from the owner acting directly: both hold
   * the same capability. Only the row does.
   */
  it('refuses a delegate who holds the capability but is not the current owner', () => {
    const failure = thrown(() =>
      assertTransferable(actorWith({ userId: DELEGATE }), OWNER, recipient()),
    );

    expect(failure).toBeInstanceOf(AccessRefusedError);
    expect(failure).toMatchObject({ reason: 'not_the_owner', code: 'not_the_owner', status: 403 });
  });

  it('refuses the delegate before the self-transfer check, even naming themselves', () => {
    // `not_the_owner` outranks `invalid_recipient` on purpose: the delegate is not in a position to
    // give the organization to anybody, themselves included, and the two refusals have different
    // remedies — «ask the owner» is not «pick somebody else».
    const failure = thrown(() =>
      assertTransferable(actorWith({ userId: DELEGATE }), OWNER, recipient({ userId: DELEGATE })),
    );

    expect(failure).toMatchObject({ reason: 'not_the_owner', status: 403 });
  });

  it('refuses the delegate even when the recipient named is the organization’s real owner', () => {
    // Not a way to launder the operation: handing it "back" to the actual owner does not make the
    // delegate the owner. `assertTransferable` compares the *actor* against `currentOwnerId`, not
    // against the recipient — after the fix for defect 1 the two are the same fact, and this pins
    // that «transfer to the current holder» really is unreachable except for the owner themselves.
    const failure = thrown(() =>
      assertTransferable(actorWith({ userId: DELEGATE }), OWNER, recipient({ userId: OWNER })),
    );

    expect(failure).toMatchObject({ reason: 'not_the_owner', status: 403 });
  });

  it('refuses the owner handing it to themselves', () => {
    const failure = thrown(() =>
      assertTransferable(actorWith(), OWNER, recipient({ userId: OWNER })),
    );

    expect(failure).toBeInstanceOf(AccessRefusedError);
    expect(failure).toMatchObject({
      reason: 'invalid_recipient',
      code: 'invalid_recipient',
      status: 422,
    });
  });

  it.each(['SUSPENDED', 'INVITED'] as const)('refuses a recipient who is %s', (status) => {
    const failure = thrown(() => assertTransferable(actorWith(), OWNER, recipient({ status })));

    expect(failure).toBeInstanceOf(ConflictError);
    expect(failure).toMatchObject({ code: 'recipient_not_active', status: 409 });
    expect((failure as ConflictError).details).toEqual({ cause: status });
  });
});
