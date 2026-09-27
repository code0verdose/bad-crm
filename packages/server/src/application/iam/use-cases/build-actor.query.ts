import { actorFromFacts } from '@/application/iam/actor-from-facts.util.js';
import { type EffectivePermissionsReaderPort } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';
import { MfaEnrollmentRequiredError } from '@/domain/shared/errors/app.errors.js';

export interface BuildActorInput {
  readonly userId: string;
  readonly organizationId: string;
  /**
   * The caller's session is scoped to second-factor enrolment (STORY-013-05, acceptance 3).
   *
   * **Required, not optional with a default.** A default of `false` would make «forgot to pass it»
   * mean «unscoped», which is the direction that fails open — the one shape of this field that must
   * not compile.
   */
  readonly mfaEnrollment: boolean;
}

/**
 * Turns an authenticated caller into an actor — the only thing the permission layer takes.
 *
 * The authentication guard answers «who is this»; this answers «what may they do», and the two are
 * separate on purpose. A token says what was true when it was issued: roles change, a role expires,
 * an assignment is revoked — and the acceptance criterion of STORY-011-04 is that the *next* request
 * runs with the new rights, without a re-login. That is only possible if the capability view is read
 * per request rather than carried in the token.
 *
 * **The cost is measured, and it is not cached.** §8 of the permission model designs a 60-second
 * Redis cache keyed by `permissionsVersion`; on 2026-09-06 the read was measured instead of guessed
 * at — 5.4 ms mean and 6.0 ms p95 for a subject with 317 effective keys, eleven statements that do
 * not grow with the number of roles, 700+ builds a second, and the cache stampede the lock exists
 * for (200 simultaneous rebuilds) passing without one. That is 4 % of the 150 ms NFR-2 gives a
 * single-entity read, so the cache was refused rather than deferred: a lock, a degradation path and
 * a "the version moved while we were building" race are three new ways to be wrong about access,
 * and the saving is under six milliseconds — the version has to be read from the database on every
 * request either way, and today it arrives inside these same eleven statements. The numbers, and
 * the numeric conditions that would reverse the decision, are in §8 and in STORY-011-08; the
 * property they rest on is guarded by
 * `test/integration/db/effective-permissions-cost.test.ts`.
 *
 * A caller whose account has disappeared between the token and this read is refused as **404** —
 * `denyAccess` with the scope that means «not yours, or not there», because those two must stay
 * indistinguishable from outside.
 */
export class BuildActorQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly permissions: EffectivePermissionsReaderPort,
  ) {}

  async execute(input: BuildActorInput): Promise<Actor> {
    // The second of the two refusals STORY-013-05 acceptance 3 asks for, and the authoritative one:
    // `require-full-session.middleware.ts` refuses earlier and cheaper, but it is presentation, and
    // invariant 2 of CLAUDE.md is that the decision may not live only there. Every capability-gated
    // use-case reaches its actor through this query, so a route that somehow lost the guard still
    // cannot act under a scoped session. Refused **before** the read, because there is nothing this
    // caller may be told about their own rights while the only thing they may do is enrol.
    if (input.mfaEnrollment) throw new MfaEnrollmentRequiredError();

    return this.unitOfWork.withTenant(
      { organizationId: input.organizationId, userId: input.userId },
      async () => {
        const facts = await this.permissions.capabilitiesOf(input.userId);

        if (facts === null) throw denyAccess('user', 'other_organization');

        return actorFromFacts(input.userId, input.organizationId, facts);
      },
    );
  }
}
