import { AsyncLocalStorage } from 'node:async_hooks';

import {
  type RequestContext,
  type RequestContextPort,
} from '@/application/platform/ports/request-context.port.js';

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
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(context: RequestContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  current(): RequestContext | undefined {
    return this.storage.getStore();
  }
}
