import { PERMISSIONS } from '@bad-crm/shared/permissions';
import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_MARKER,
  readOpenApiDocument,
  specAuthorizationForm,
  specOperationEntries,
  type OperationObject,
  type SpecOperation,
} from './openapi-document.util.js';

/**
 * Invariant 2 of CLAUDE.md, asserted against the contract rather than only against the router.
 *
 * The registry in `presentation/http/route-registry.factory.ts` already refuses a route with no
 * permission and no stated reason for being public, and `openapi.test.ts` checks it. That check
 * happens when the route is written — which, under contract-first, is after the API has been
 * designed, reviewed and merged. By then "who is allowed to call this" has already been decided by
 * whoever wrote the path, and nobody was asked.
 *
 * So the document answers it too. Every operation declares exactly one of:
 *
 * - `x-permission` — a key from `packages/shared/src/permissions/permissions.catalog.ts`, checked
 *   here so that a typo is a failing test rather than a permission nobody holds;
 * - `x-public-reason` — reachable without credentials, and why (`docs/security/permission-model.md`
 *   requires a non-empty reason; the registry requires the same string);
 * - `x-self-service-reason` — authenticated, and no capability applies because the subject and the
 *   object are the same person. This is the shape `permission-model.md` §3.20 already uses for a
 *   person's own key pair, and EPIC-006 is the second family of it: closing one's own session or
 *   changing one's own password is verified by ownership, not by a right anybody could revoke.
 *
 * The third form is the one to watch. It is a real category and it is also the obvious place to
 * hide an operation that should have had a permission, which is why it carries a written reason and
 * why `permission-matrix-auditor` reads this file.
 */

const document = (): ReturnType<typeof readOpenApiDocument> => readOpenApiDocument();

const operations = (): SpecOperation[] => specOperationEntries(document());

/**
 * The marker names come from `openapi-document.util.ts`, which is also what `openapi.test.ts` reads
 * when it compares these markers with the route registry. A second list here would be a second
 * vocabulary, and the two would agree right up until a form was added to one of them.
 */
const PERMISSION = AUTHORIZATION_MARKER.permission;
const PUBLIC_REASON = AUTHORIZATION_MARKER.public;
const SELF_SERVICE_REASON = AUTHORIZATION_MARKER['self-service'];

const MARKERS = [PERMISSION, PUBLIC_REASON, SELF_SERVICE_REASON] as const;

const declared = (operation: OperationObject): string[] =>
  MARKERS.filter((marker) => operation[marker] !== undefined);

/**
 * Operations whose `x-permission` is not a key of the shared catalog, as a function of a list.
 *
 * Extracted from the assertion it serves because that assertion has never once executed its own
 * body against a real value: no operation in `docs/api/openapi.yaml` declares `x-permission` yet —
 * every one of them is public or self-service — so the filter yields an empty list, `toEqual([])`
 * passes, and the check would pass just as happily if `known` were built from the wrong array or
 * the comparison were inverted. A rule nobody has ever seen fail is a rule nobody knows works.
 *
 * The literal control used for anonymous operations ("at least one exists") cannot be written here:
 * it would be red until the first capability-gated endpoint lands, and a suite that is red on
 * purpose is a suite people learn to ignore. So the control is applied to the predicate instead —
 * fed a known-good key and a known-bad one below.
 */
const unknownPermissions = (entries: readonly SpecOperation[]): string[] => {
  const known: ReadonlySet<string> = new Set<string>(PERMISSIONS);

  return entries
    .filter((entry) => entry.operation[PERMISSION] !== undefined)
    .filter((entry) => !known.has(text(entry.operation, PERMISSION)))
    .map((entry) => `${entry.routeKey} → ${text(entry.operation, PERMISSION)}`);
};

const text = (operation: OperationObject, marker: string): string => {
  const value = operation[marker];

  return typeof value === 'string' ? value : '';
};

/**
 * Whether the operation can be reached with no credentials at all.
 *
 * `security: []` on the operation is the only way to say so: an operation that omits `security`
 * inherits the document default, which this API sets to `bearerAuth`. Reading the default rather
 * than assuming it means that relaxing the default is a change this suite notices.
 */
const isAnonymous = (operation: OperationObject): boolean =>
  Array.isArray(operation['security']) && (operation['security'] as unknown[]).length === 0;

describe('every operation says who may call it', () => {
  it('sets the document-level default to an authenticated caller', () => {
    expect(document().security).toEqual([{ bearerAuth: [] }]);
  });

  it('declares exactly one of permission, public reason or self-service reason', () => {
    const wrong = operations()
      .map((entry) => ({ route: entry.routeKey, markers: declared(entry.operation) }))
      .filter((entry) => entry.markers.length !== 1);

    expect(
      wrong,
      `each operation needs exactly one of ${MARKERS.join(', ')} — none means nobody decided, two mean the decision is ambiguous`,
    ).toEqual([]);
  });

  it('takes every permission from the closed catalog', () => {
    expect(
      unknownPermissions(operations()),
      'x-permission must be a key of packages/shared/src/permissions/permissions.catalog.ts — a literal invented at the call site is exactly what invariant 2 forbids',
    ).toEqual([]);
  });

  /**
   * The positive control the assertion above cannot have of its own.
   *
   * It is the mutation test in miniature: the check is handed an operation that declares a key the
   * catalog holds and one that declares a plausible typo, and has to separate them. Without this,
   * the empty list the real document produces is indistinguishable from a check that stopped
   * working, and the day EPIC-011 adds the first `x-permission` nobody would find out.
   */
  it('recognises a key of the catalog and reports one that only looks like it', () => {
    const entry = (permission: string): SpecOperation => ({
      method: 'GET',
      documentPath: '/tasks',
      routeKey: 'GET /api/v1/tasks',
      operation: { [PERMISSION]: permission },
    });

    expect(unknownPermissions([entry('task:read')])).toEqual([]);
    expect(unknownPermissions([entry('task:reed')])).toEqual(['GET /api/v1/tasks → task:reed']);
    expect(unknownPermissions([entry('')])).toHaveLength(1);
  });

  it('pairs an anonymous operation with a public reason, and nothing else with one', () => {
    const mismatched = operations()
      .map((entry) => ({
        route: entry.routeKey,
        anonymous: isAnonymous(entry.operation),
        claimsPublic: entry.operation[PUBLIC_REASON] !== undefined,
      }))
      .filter((entry) => entry.anonymous !== entry.claimsPublic);

    expect(
      mismatched,
      '`security: []` and x-public-reason go together: a public reason on a guarded operation is a stale claim, and an unexplained `security: []` is an endpoint nobody reviewed',
    ).toEqual([]);
  });

  it.each([PUBLIC_REASON, SELF_SERVICE_REASON])('states a real reason in %s', (marker) => {
    const thin = operations()
      .filter((entry) => entry.operation[marker] !== undefined)
      .map((entry) => ({ route: entry.routeKey, reason: text(entry.operation, marker) }))
      .filter((entry) => entry.reason.trim().length < 40);

    expect(thin, 'a reason of a few words is a box ticked, not a decision recorded').toEqual([]);
  });

  it('has operations to check, so none of the above is vacuous', () => {
    expect(operations().length).toBeGreaterThan(5);
    expect(operations().filter((entry) => isAnonymous(entry.operation)).length).toBeGreaterThan(0);
  });

  /**
   * Every form is used by the document as it stands, which is the other half of "not vacuous": the
   * self-service form in particular is the one this epic introduced, and a document where nothing
   * carried it would make the reader below untested against the case it exists for.
   */
  it('uses each of the three forms at least once', () => {
    const forms = operations().map((entry) => specAuthorizationForm(entry.operation));

    expect(forms).toContain('public');
    expect(forms).toContain('self-service');
    expect(forms.filter((form) => form === undefined)).toEqual([]);
  });
});

/**
 * The reader `openapi.test.ts` compares against the route registry, held to the cases the document
 * does not currently contain.
 *
 * It answers `undefined` for "none" and for "more than one" alike, and that is deliberate: the
 * comparison with the registry must not pick a winner out of an operation somebody marked twice.
 * The suite above reports both situations by name; this proves the reader does not quietly resolve
 * them.
 */
describe('reading the authorization marker of an operation', () => {
  it.each([
    [{ [PERMISSION]: 'task:read' }, 'permission'],
    [{ [PUBLIC_REASON]: 'because' }, 'public'],
    [{ [SELF_SERVICE_REASON]: 'because' }, 'self-service'],
  ])('reads %o as %s', (operation, form) => {
    expect(specAuthorizationForm(operation)).toBe(form);
  });

  it('answers nothing for an operation that declares none, and for one that declares two', () => {
    expect(specAuthorizationForm({})).toBeUndefined();
    expect(
      specAuthorizationForm({ [PERMISSION]: 'task:read', [PUBLIC_REASON]: 'because' }),
    ).toBeUndefined();
  });
});

/**
 * Nothing that is a credential travels where a proxy, a browser or a support ticket can copy it.
 *
 * The rule is already visible in two places — `Problem` has no `instance` member, and the HTTP
 * logger records a route template rather than a URL (CLAUDE.md, «Чувствительность данных»). Both
 * are defeated by a single operation that takes a secret as a query parameter, because the URL is
 * then written to the access log of every proxy in front of the installation and handed to the next
 * origin in `Referer` regardless of what this process does.
 *
 * `/l/{token}` is the one deliberate exception in the product and it is not in this document.
 */
describe('no secret is addressable through a URL', () => {
  const SECRETISH = /token|password|secret|credential|key/i;

  interface ParameterLike {
    name?: unknown;
    in?: unknown;
    $ref?: unknown;
  }

  /**
   * Follows a `$ref` into `components.parameters` before reading `name` and `in`.
   *
   * Without this, the assertion below is decorative: a shared parameter is written as
   * `{ $ref: '#/components/parameters/ResetToken' }`, and an unresolved reference has no `in` to
   * recognise as `query`. The one form somebody would actually use to add a reusable parameter is
   * exactly the form that would have slipped past.
   */
  const resolved = (parameter: ParameterLike): ParameterLike => {
    const reference = parameter.$ref;

    if (typeof reference !== 'string') return parameter;

    const name = reference.replace('#/components/parameters/', '');
    const components = (
      document() as { components?: { parameters?: Record<string, ParameterLike> } }
    ).components;
    const target = components?.parameters?.[name];

    if (target === undefined) {
      throw new Error(
        `docs/api/openapi.yaml: parameter reference "${reference}" resolves to nothing`,
      );
    }

    return target;
  };

  const parameterNames = (entry: SpecOperation): { name: string; location: string }[] => {
    const parameters = entry.operation['parameters'];

    if (!Array.isArray(parameters)) return [];

    return parameters
      .map((parameter) => resolved(parameter as ParameterLike))
      .map((parameter) => ({
        name: typeof parameter.name === 'string' ? parameter.name : '',
        location: typeof parameter.in === 'string' ? parameter.in : 'unknown',
      }));
  };

  it('declares no query or path parameter that could carry one', () => {
    const offenders = operations().flatMap((entry) =>
      parameterNames(entry)
        .filter((parameter) => parameter.location === 'query' || parameter.location === 'path')
        .filter((parameter) => SECRETISH.test(parameter.name))
        .map((parameter) => `${entry.routeKey} ${parameter.location}:${parameter.name}`),
    );

    expect(
      offenders,
      'a secret belongs in a request body: a query string reaches proxy logs, `Referer` and the clipboard',
    ).toEqual([]);
  });

  /**
   * The positive control. Without it the assertion above would also pass on a document that declares
   * no parameters at all, which is not the same thing as declaring safe ones.
   */
  it('is checking a document that does declare parameters', () => {
    const all = operations().flatMap(parameterNames);

    expect(all.length).toBeGreaterThan(0);
    expect(SECRETISH.test('resetToken')).toBe(true);
  });

  /**
   * And that it reads them through their references. `Idempotency-Key` is declared once in
   * `components.parameters` and used by `$ref`, so seeing it here proves the resolution above ran —
   * an unresolved entry would have arrived with no name and no location at all.
   */
  it('reads a parameter that is used through a reference', () => {
    const all = operations().flatMap(parameterNames);

    expect(all).toContainEqual({ name: 'Idempotency-Key', location: 'header' });
    expect(all.filter((parameter) => parameter.location === 'unknown')).toEqual([]);
  });
});
