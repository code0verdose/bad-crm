import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
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
  readonly http: HttpServerDependencies;
}
