import {
  type RecoveryCodeCounts,
  type RecoveryCodeRepositoryPort,
} from '@/application/identity/ports/recovery-code-repository.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';

/**
 * `GET /auth/2fa/recovery-codes` — the counter, and only the counter.
 *
 * `{ total, remaining }` is the entire shape this endpoint may ever answer with (STORY-013-02,
 * acceptance 2): the plaintext codes exist nowhere after the response that first showed them, so there
 * is nothing this query could read back even if its contract allowed more.
 */
export class ReadRecoveryCodeStatusQuery {
  constructor(
    private readonly codes: RecoveryCodeRepositoryPort,
    private readonly unitOfWork: UnitOfWorkPort,
  ) {}

  execute(actor: {
    readonly organizationId: string;
    readonly userId: string;
  }): Promise<RecoveryCodeCounts> {
    return this.unitOfWork.withTenant(actor, () => this.codes.counts(actor.userId));
  }
}
