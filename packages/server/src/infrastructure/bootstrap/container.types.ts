import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type ProcessLifecycleAdapter } from '@/infrastructure/platform/process-lifecycle.adapter.js';
import { type HttpServerDependencies } from '@/presentation/http/http-server.types.js';
import { type ServerEnv } from '@/infrastructure/bootstrap/env.schema.js';

/** One resource the process must close before it exits. */
export interface ShutdownStep {
  readonly name: string;
  close(): Promise<void> | void;
}

/**
 * One thing the process must prove about a client it opened, **before** it opens its port.
 *
 * The mirror image of `ShutdownStep`, and for the same structural reason: the check belongs to
 * whatever the composition root built, so a client that is only constructed under a condition
 * brings its own verification instead of leaving `startApiProcess` to guess whether it exists.
 *
 * A failing check refuses the start. That is the point — the failures these catch (a second pool
 * connected as the schema owner, a password that is wrong) produce no error at runtime and no
 * symptom until somebody signs in, at which point either nobody can or everybody can read
 * everything.
 */
export interface StartupCheck {
  readonly name: string;
  run(): Promise<unknown>;
}

/**
 * Everything the process is made of, assembled once.
 *
 * Plain data, no framework: the container is an object literal built by a function, so "what does
 * this depend on" is answered by reading `container.factory.ts` top to bottom rather than by
 * tracing decorators and metadata (rules/hexagonal-backend.mdc, rule 12).
 */
export interface AppContainer {
  readonly env: ServerEnv;
  readonly logger: LoggerPort;
  /** The concrete adapter, not the port: the shutdown handler needs the writing side. */
  readonly lifecycle: ProcessLifecycleAdapter;
  /** Closed in order during graceful shutdown; Prisma and Redis join it in STORY-003-06. */
  readonly shutdownSteps: readonly ShutdownStep[];
  /** Run before the port opens; a rejection is a refusal to start (`api-process.factory.ts`). */
  readonly startupChecks: readonly StartupCheck[];
  /**
   * The one hasher every argon2id computation of this process goes through, ceiling included.
   *
   * **This field is a seam, and it is published deliberately rather than quietly.** The ceiling of
   * STORY-013-06 is a property of the *process*, not of any one endpoint, and until this line it had
   * no observation point outside `buildIdentity`: the hasher was reachable only through a use-case,
   * and every use-case that touches it needs a database first. A test that builds its own
   * `LimitedPasswordHasher` proves the wiring of the test, which is the exact hole this closes —
   * deleting the decorator from `container.factory.ts` left the whole server suite green.
   *
   * It is the **same instance** the use-cases received, not a second construction: reading it can
   * neither create a hasher outside the ceiling nor tune one, which is what makes publishing it
   * cheaper than the alternative of exporting the slice builder and rebuilding half the composition
   * root in a test. Nothing in `src/` reads it; if something ever does, it must be for the process's
   * own hashing and not to build a second path around the queue.
   */
  readonly passwordHasher: PasswordHasherPort;
  /**
   * The one audit writer every use-case of this process records through, decorators included.
   *
   * **A seam of the same kind as `passwordHasher`, published for the same reason.** The chain is
   * three decorators whose order is the contract — the counter inside so it sees every failure,
   * the degrading decision outside so it decides who else does (`container.factory.ts`) — and until
   * this line the order had no observation point: every suite that proved it built the chain by
   * hand, so swapping the two decorators in the composition root left the whole server suite green
   * while `audit_write_failed_total` stopped counting exactly the failures it exists to count.
   *
   * It is the **same instance** the use-cases received: reading it can neither build a second
   * writer around the counter nor reach the transaction behind one. Nothing in `src/` reads it.
   */
  readonly audit: AuditLoggerPort;
  readonly http: HttpServerDependencies;
}
