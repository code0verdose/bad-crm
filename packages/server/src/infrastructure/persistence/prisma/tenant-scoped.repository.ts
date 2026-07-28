import { type ErrorResource } from '@bad-crm/shared/errors';
import { Prisma } from '@prisma/client';

import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';
import {
  requireTenant,
  type TxClient,
} from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The base every Prisma repository extends.
 *
 * Its whole job is to remove two choices from the author of a repository.
 *
 * **Which transaction to run on.** Not a constructor argument, not a method parameter: the one
 * opened by `withTenant`, read out of AsyncLocalStorage at the moment of the call. A repository
 * that accepted a transaction could be handed one from a different scope, and a repository that
 * accepted an `organizationId` would have a second source of truth for the tenant — one that a
 * caller can get wrong. When the two disagree the query is not rejected, it is *filtered*: the
 * policy compares rows against `app.organization_id`, so the result is an empty list that reads
 * like "no data" (docs/security/rls-design.md, «Ловушки», 3).
 *
 * **Whether the tenant scope is open at all.** `guardedClient` catches a model call made outside
 * one, but only for calls that go through the guarded client; a repository holding the transaction
 * handle bypasses it by construction. `run` asks `requireTenant` first, so the refusal happens here
 * as well, before any statement is sent, and names the repository and the operation instead of
 * leaving a Postgres error code (`42704`) for somebody to decode.
 *
 * Error translation rides along for the same reason: it is not something a subclass may forget,
 * because `run` is the only way a subclass reaches the database.
 */
export abstract class TenantScopedRepository {
  /** The resource whose error codes this repository raises: `team` → `team_already_exists`. */
  protected abstract readonly resource: ErrorResource;

  /** Used in the refusal message; the class name is not reliable after minification. */
  protected abstract readonly repositoryName: string;

  /**
   * The organization of the scope in effect.
   *
   * Exposed to subclasses because a few statements genuinely need the value — the tenant root
   * writes it as its own primary key — and reading it here is the only way to obtain one that
   * cannot disagree with `app.organization_id`.
   */
  protected organizationId(operation = 'organizationId'): string {
    return requireTenant(`${this.repositoryName}.${operation}`).ctx.organizationId;
  }

  /**
   * Runs one unit of work on the transaction of the current tenant scope.
   *
   * Every repository method is a call to this and nothing else.
   */
  protected async run<T>(operation: string, work: (tx: TxClient) => Promise<T>): Promise<T> {
    const { tx } = requireTenant(`${this.repositoryName}.${operation}`);

    try {
      return await work(tx);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * The two Prisma failures that are *expected outcomes of a valid request* rather than defects.
   *
   * Everything else — a row-level-security refusal above all — travels up untouched and is answered
   * `500 internal_error`. `new row violates row-level security policy` means this code tried to
   * write into another organization: a tidy 409 in its place would hand a client something to act
   * on and hide the defect from the log that matters.
   */
  private translate(error: unknown): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return error;

    // P2002: unique constraint. For the tenant root that is the globally unique `slug`, and it is
    // the *only* way a duplicate can be detected — a pre-flight `SELECT ... WHERE slug = $1` runs
    // under the policy of an organization that does not exist yet and always finds nothing.
    if (error.code === 'P2002') {
      return new ConflictError(`${this.resource}_already_exists`, { cause: error.code });
    }

    // P2025: "an operation failed because it depends on one or more records that were required but
    // not found". Under RLS that covers a row of another organization too — the policy simply does
    // not return it — and the two must stay indistinguishable from outside, or the API becomes an
    // oracle for what exists in other tenants. `denyAccess` is where that choice is made, once
    // (invariant 2 of CLAUDE.md); constructing the error here would be a second place to make it.
    if (error.code === 'P2025') return denyAccess(this.resource, 'other_organization');

    return error;
  }
}
