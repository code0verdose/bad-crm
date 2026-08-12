import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ValidationError } from '../../src/domain/shared/errors/app.errors.js';
import { validate } from '../../src/presentation/http/middleware/validate.middleware.js';
import { createRouteRegistry } from '../../src/presentation/http/route-registry.factory.js';
import { type RouteDeclaration } from '../../src/presentation/http/route-registry.types.js';
import { createTestApp } from '../support/test-app.util.js';
import { normalizePath } from './collect-routes.util.js';
import { readOpenApiDocument, specOperationEntries } from './openapi-document.util.js';

/**
 * Which response codes an operation may answer with is part of the contract, and until this file
 * nothing compared that part with the code.
 *
 * `openapi.test.ts` compares the *set of operations* with the router and `error-codes.test.ts`
 * compares the *global catalogue* of error codes with `packages/shared` — both pass while a single
 * operation omits a status it demonstrably returns. That gap is not hypothetical: STORY-013-04
 * shipped `POST /users/{userId}/reset-mfa` without `422` while its two neighbours in the same file,
 * validating the same branded-UUID path parameter with the same schema, both declared it. A client
 * generated from that document has no branch for the answer the server actually sends.
 *
 * The mechanically checkable half is `422`. It is produced by exactly one thing — a middleware
 * mounted in front of the controller raising `ValidationError` — so "can this operation answer 422"
 * is a question about the route's own middleware chain, and this suite asks the chain rather than
 * consulting a list. A list is what already drifted: it would have to be edited by the same person
 * who forgot to edit the document.
 *
 * What this suite deliberately does **not** try to derive is the rest of the codes. See the block
 * comment above the last `describe`.
 */

/**
 * A request every schema at this boundary rejects, and no schema quietly accepts.
 *
 * `null` for all three sources rather than a plausible-but-wrong value: every request schema in
 * `presentation/http/validators/**` is a `z.object`/`z.strictObject`, and none of them accepts
 * `null`. A missing `Idempotency-Key` header does the same job for `requireIdempotencyKey`, which
 * raises the same `ValidationError` and is therefore just as much a 422 the operation can answer.
 */
const probeRequest = (route: RouteDeclaration): Request =>
  ({
    method: route.method.toUpperCase(),
    path: route.path,
    url: route.path,
    originalUrl: route.path,
    headers: {},
    params: null,
    query: null,
    body: null,
    get: () => undefined,
  }) as unknown as Request;

type Outcome = 'validation-error' | 'other-error' | 'passed';

/** Runs one middleware against the probe and reports which of the three things it did. */
const runGate = async (handler: RequestHandler, route: RouteDeclaration): Promise<Outcome> => {
  let outcome: Outcome = 'passed';
  const next = ((error?: unknown): void => {
    if (error === undefined) return;

    outcome = error instanceof ValidationError ? 'validation-error' : 'other-error';
  }) as NextFunction;

  try {
    const returned = handler(probeRequest(route), { locals: {} } as unknown as Response, next);

    if (returned instanceof Promise) await returned;
  } catch (error) {
    outcome = error instanceof ValidationError ? 'validation-error' : 'other-error';
  }

  return outcome;
};

/**
 * Whether the route can answer 422, asked of the route itself.
 *
 * Each middleware is probed **independently** rather than as a chain, and that is not a shortcut.
 * `createRouteRegistry` returns the finished stack — authentication and the permission guard sit in
 * front of the validator — so a chain walk stops at `UnauthenticatedError` on every guarded route
 * and would report that nothing on the API validates anything. The question here is not "what does
 * an anonymous caller get", which is 401 by design; it is "does a 422 exist on this operation at
 * all", and it does exactly when some middleware in front of the controller raises
 * `ValidationError` for input it will not accept.
 *
 * The **last** handler is never called: `RouteBase.handlers` is documented as "validator middleware
 * first, controller last", and invoking a controller with a null body would exercise use-cases
 * rather than ask a question about validation.
 */
const answers422 = async (route: RouteDeclaration): Promise<boolean> => {
  for (const handler of route.handlers.slice(0, -1)) {
    if ((await runGate(handler, route)) === 'validation-error') return true;
  }

  return false;
};

const routeKeyOf = (route: RouteDeclaration): string =>
  `${route.method.toUpperCase()} ${normalizePath(route.path)}`;

const validatingRouteKeys = async (): Promise<Set<string>> => {
  const registry = createRouteRegistry(createTestApp().container.http);
  const keys = new Set<string>();

  for (const route of registry) {
    if (await answers422(route)) keys.add(routeKeyOf(route));
  }

  return keys;
};

/** `routeKey` → the response codes the document declares for it. */
const declaredResponses = (): Map<string, Set<string>> =>
  new Map(
    specOperationEntries(readOpenApiDocument()).map((entry) => [
      entry.routeKey,
      new Set(Object.keys((entry.operation['responses'] ?? {}) as Record<string, unknown>)),
    ]),
  );

/**
 * The probe is the whole assertion, so it is itself under test — against two handlers built here,
 * not against routes that may change. A probe that answered `true` for everything would make the
 * suite below pass by accident on the day somebody deleted a validator, and a probe that answered
 * `false` for everything would make it pass vacuously forever.
 */
describe('the probe tells a validating middleware from a plain one', () => {
  const route = (handlers: readonly RequestHandler[]): RouteDeclaration =>
    ({
      method: 'post',
      path: '/api/v1/probe/:id',
      handlers: [...handlers, (_request, _response, next) => next()],
      public: true,
      publicReason: 'a fixture of this suite, never mounted',
    }) as RouteDeclaration;

  const pass: RequestHandler = (_request, _response, next) => next();

  it('sees a params schema', async () => {
    const gate = validate({ params: z.strictObject({ id: z.string() }) });

    await expect(answers422(route([gate.handler]))).resolves.toBe(true);
  });

  it('sees a body schema', async () => {
    const gate = validate({ body: z.strictObject({ name: z.string() }) });

    await expect(answers422(route([gate.handler]))).resolves.toBe(true);
  });

  it('does not see one where there is none', async () => {
    await expect(answers422(route([pass]))).resolves.toBe(false);
  });

  it('does not see one on a route that is nothing but its controller', async () => {
    await expect(answers422(route([]))).resolves.toBe(false);
  });

  it('reports a refusal that is not a validation failure as no 422', async () => {
    const refuses: RequestHandler = (_request, _response, next) => next(new Error('nope'));

    await expect(answers422(route([refuses]))).resolves.toBe(false);
  });

  /**
   * The property the independent probing exists for: a guard that refuses first — which on every
   * authenticated route is what actually happens — must not hide the validator behind it.
   */
  it('sees a validator standing behind a guard that refuses first', async () => {
    const refuses: RequestHandler = (_request, _response, next) => next(new Error('401'));
    const gate = validate({ params: z.strictObject({ id: z.string() }) });

    await expect(answers422(route([refuses, gate.handler]))).resolves.toBe(true);
  });
});

describe('every operation that can answer 422 declares it', () => {
  it('has routes on both sides of the comparison, so it is not vacuous', async () => {
    const validating = await validatingRouteKeys();
    const documented = declaredResponses();

    expect(validating.size).toBeGreaterThan(0);
    expect([...validating].filter((key) => documented.has(key)).length).toBeGreaterThan(0);
  });

  /**
   * The registry has to contain routes of both kinds, or the assertion below is a tautology: if
   * every route validated something, "the validating ones declare 422" would be indistinguishable
   * from "every operation declares 422", and deleting a validator would go unnoticed.
   */
  it('finds routes that validate nothing, so the set is a real subset', async () => {
    const registry = createRouteRegistry(createTestApp().container.http);
    const validating = await validatingRouteKeys();

    expect(validating.size).toBeLessThan(registry.length);
  });

  it('declares 422 wherever a middleware in front of the controller can raise one', async () => {
    const documented = declaredResponses();
    const undeclared = [...(await validatingRouteKeys())]
      .filter((key) => documented.has(key))
      .filter((key) => !documented.get(key)?.has('422'))
      .sort();

    expect(
      undeclared,
      `operation validates its input but does not declare '422' in docs/api/openapi.yaml: ${undeclared.join(', ')} — a request the server rejects with 422 validation_failed is an answer no generated client has a branch for`,
    ).toEqual([]);
  });

  /**
   * The other direction. `422` is answered by request validation and by nothing else, so an
   * operation that publishes it while its route validates nothing promises a refusal it cannot
   * produce — the same drift, pointing the other way.
   */
  it('does not publish 422 on an operation whose route validates nothing', async () => {
    const validating = await validatingRouteKeys();
    const declared = new Set(createRouteRegistry(createTestApp().container.http).map(routeKeyOf));
    const overpromised = [...declaredResponses().entries()]
      .filter(([key]) => declared.has(key))
      .filter(([key, codes]) => codes.has('422') && !validating.has(key))
      .map(([key]) => key)
      .sort();

    expect(
      overpromised,
      `operation declares '422' but nothing in front of its controller can raise one: ${overpromised.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * What this suite does not check, stated so that the next reader does not mistake its silence for
 * coverage — the reason `rules/testing.mdc` gives for a gate that has never been red.
 *
 * The other half of STORY-013-04's contract audit was `503`, missing from all three 2FA operations
 * whose use-case decrypts `totpSecretEnc` and raises `ServiceUnavailableError` when
 * `APP_ENCRYPTION_KEY` cannot read it. **That half is not derivable the way `422` is**, and writing
 * a check that appears to derive it would be worse than admitting the gap:
 *
 * - `503` is not raised by anything the route declaration can be asked about. It comes out of a
 *   `catch` inside a use-case the registry only knows as a controller closure — reaching it needs
 *   the repository to return a row whose ciphertext does not decrypt, which is a fixture, not an
 *   introspection.
 * - Reading it off the *type* of thrown error does not work either. Static extraction would have to
 *   follow `throw` statements through every port a use-case calls, and it is the ports that throw
 *   the interesting ones: `RateLimitPort.consume` raises `ServiceUnavailableError` whenever Redis is
 *   unreachable, which makes `503` reachable on **every operation that spends a budget** — that is,
 *   on every operation this document gives a `429`, while it states the 503 on two of them (`login`,
 *   `refresh`). A grep-shaped check would either miss that entirely or demand `503` across most of
 *   the surface without anybody having decided that is what the contract should say. Both outcomes
 *   are noise wearing the costume of a gate; the first is worse, because it looks like a pass.
 * - The honest mechanism for the rest of the codes is a per-operation test that provokes each
 *   refusal and asserts the status against the document. That is real work per operation and it
 *   belongs to the epic that adds the operation, not to a comparison that runs over all of them.
 *
 * So: `422` is closed here, mechanically and without a list. `503`, `409` and the rest are declared
 * by hand and reviewed by hand, and the gap above is the reason.
 */
