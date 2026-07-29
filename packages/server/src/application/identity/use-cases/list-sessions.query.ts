import { type SessionRepositoryPort } from '@/application/identity/ports/session-repository.port.js';
import { type SessionActor } from '@/application/identity/use-cases/end-session.use-case.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { describeDevice } from '@/domain/identity/session-device.util.js';

/** One row of `/settings/security`, already in the shape the contract publishes. */
export interface SessionListEntry {
  readonly id: string;
  readonly current: boolean;
  readonly device: string;
  readonly ipMasked: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The caller's own live sessions, one entry per device.
 *
 * A read, and only a read — hence `.query.ts`. Two things happen here that deliberately do not
 * happen in the repository:
 *
 * - **the user agent becomes a sentence.** Derived on the way out rather than stored, so improving
 *   the parser improves the rows that already exist, and the raw agent — a fingerprint — never
 *   leaves the server (`docs/api/openapi.yaml`, `SessionSummary.device`);
 * - **"current" is decided by family.** The id of the caller's own session changes on every
 *   rotation, so comparing ids would mark the wrong row the moment a refresh happened between the
 *   token being minted and the list being read.
 *
 * The full address is not here and is not anywhere: `ipMasked` was computed at sign-in, before the
 * row was written, and the other column is a keyed digest.
 */
export class ListSessionsQuery {
  constructor(
    private readonly sessions: SessionRepositoryPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(actor: SessionActor, currentSessionId: string): Promise<SessionListEntry[]> {
    const now = this.clock.now();

    return this.unitOfWork.withTenant(actor, async () => {
      const active = await this.sessions.listActive(actor.userId, now);
      const currentFamily = active.find((session) => session.id === currentSessionId)?.familyId;

      return active.map((session) => ({
        id: session.id,
        current: session.familyId === currentFamily,
        device: describeDevice(session.userAgent),
        ipMasked: session.ipMasked,
        createdAt: session.startedAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
      }));
    });
  }
}
