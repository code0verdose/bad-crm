/**
 * What every log line, audit record and outgoing event of one request carries.
 *
 * `organizationId` and `userId` are `null` until authentication fills them in (EPIC-006): the
 * fields exist from day one so that the shape of a log line never changes, and so that a missing
 * tenant is visibly `null` rather than silently absent.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly organizationId: string | null;
  readonly userId: string | null;
}

/**
 * Ambient per-request state, without threading a parameter through every layer.
 *
 * The implementation is `AsyncLocalStorage` (`infrastructure/logging`), but nothing above
 * `infrastructure` may know that: the port keeps `presentation` free of a Node built-in and lets
 * tests run a scenario with a fixed context.
 */
export interface RequestContextPort {
  /** Runs `fn` with `context` visible to everything it awaits, however deep. */
  run<T>(context: RequestContext, fn: () => T): T;
  /** The context of the running request, or `undefined` outside one (jobs, startup). */
  current(): RequestContext | undefined;
}
