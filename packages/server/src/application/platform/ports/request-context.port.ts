/**
 * What every log line, audit record and outgoing event of one request carries.
 *
 * `organizationId` and `userId` are `null` until the authentication guard resolves a credential and
 * calls `identify`, which is the earliest moment they can be known: a request arrives as a bearer
 * token, and who it belongs to is the answer to a database read. They stay `null` on the routes that
 * have no caller — `/health`, `/ready`, sign-in itself — and that is information rather than a gap,
 * which is why the shape never changes.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly organizationId: string | null;
  readonly userId: string | null;
}

/** The caller, once a credential has been resolved to one. */
export interface RequestCaller {
  readonly organizationId: string;
  readonly userId: string;
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
  /**
   * Adds the caller to the context of the running request.
   *
   * Separate from `run` because the two happen at different moments and in different layers: the
   * context is opened by the first middleware, when nothing but the request id is knowable, and the
   * caller is established by the authentication guard several steps later. Re-opening a context
   * there would give the rest of the chain a *second* scope and leave everything already awaiting
   * inside the first one.
   *
   * A no-op outside a request: jobs and startup lines belong to no caller, and inventing a store for
   * them would produce one that outlives every request.
   */
  identify(caller: RequestCaller): void;
  /** The context of the running request, or `undefined` outside one (jobs, startup). */
  current(): RequestContext | undefined;
}
