import { AsyncLocalStorage } from 'node:async_hooks';

import {
  type RequestCaller,
  type RequestContext,
  type RequestContextPort,
} from '@/application/platform/ports/request-context.port.js';

/** The store as this adapter keeps it: the same fields, writable by `identify` alone. */
type MutableRequestContext = { -readonly [K in keyof RequestContext]: RequestContext[K] };

/**
 * `RequestContextPort` on `AsyncLocalStorage`.
 *
 * The alternative — a module-level variable holding "the current request" — works in every manual
 * test and fails under load: two requests interleaved at an `await` share whatever was written
 * last, so request A's identifier appears on request B's lines. Nothing about the resulting log
 * looks wrong, which is why the failure survives for months.
 *
 * `AsyncLocalStorage` is per async execution chain, so the context follows every `await`, timer and
 * callback started inside `run` and is invisible to everything outside it. The instance is created
 * in the composition root rather than exported as a singleton, so tests never share one.
 */
export class AsyncRequestContextAdapter implements RequestContextPort {
  private readonly storage = new AsyncLocalStorage<MutableRequestContext>();

  /** Copied on the way in, so the caller's object cannot be mutated from here or vice versa. */
  run<T>(context: RequestContext, fn: () => T): T {
    return this.storage.run({ ...context }, fn);
  }

  /**
   * Writes the caller into the store of the running request.
   *
   * A mutation of the store rather than a nested `run`, and the difference is not cosmetic: the
   * guard identifies the caller in the middle of the chain, and everything already suspended inside
   * the outer scope — the `pino-http` completion line above all — reads *that* store. A nested scope
   * would fill in the fields for the handler and leave the line that closes the request saying
   * `null`, which is the one line every dashboard is built on.
   *
   * The store belongs to one async execution chain, so this is invisible to every other request.
   */
  identify(caller: RequestCaller): void {
    const context = this.storage.getStore();

    if (context === undefined) return;

    context.organizationId = caller.organizationId;
    context.userId = caller.userId;
  }

  current(): RequestContext | undefined {
    return this.storage.getStore();
  }
}
