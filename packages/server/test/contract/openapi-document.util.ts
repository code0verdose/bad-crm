import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The workspace-root `yaml` devDependency, the same one the repository-level suites use. It is
// deliberately not declared by `packages/server`: nothing under `src/**` parses YAML, and adding a
// runtime dependency to the server so that one test can read a document would be the wrong trade.
import { parse as parseYaml } from 'yaml';

import {
  AUTHORIZATION_FORMS,
  type AuthorizationForm,
} from '../../src/presentation/http/route-registry.types.js';
import { normalizePath, type CollectedRoute } from './collect-routes.util.js';

/** The contract itself, as a path this suite can also print in a failure message. */
export const OPENAPI_PATH = fileURLToPath(
  new URL('../../../../docs/api/openapi.yaml', import.meta.url),
);

/** One operation object, unresolved: whatever the YAML says under `paths.<path>.<method>`. */
export type OperationObject = Record<string, unknown>;

interface OpenApiDocument {
  servers?: { url?: string }[];
  security?: unknown[];
  paths?: Record<string, Record<string, unknown> | undefined>;
  components?: {
    schemas?: Record<string, { enum?: unknown[] } | undefined>;
  };
}

/**
 * An operation, keyed the way the router spells it and carrying the object it was read from.
 *
 * `specOperations` answers "which routes does the contract promise"; this answers "what does the
 * contract say about each one", which is what the authorization and planned-operation suites need.
 */
export interface SpecOperation {
  /** Upper-case HTTP method. */
  readonly method: string;
  /** The path as the document writes it, relative to the server prefix — `/auth/login`. */
  readonly documentPath: string;
  /** `POST /api/v1/auth/{param}` — comparable with `routeKey` of a collected Express route. */
  readonly routeKey: string;
  readonly operation: OperationObject;
}

/** Keys of a path item that are not operations (OpenAPI 3.1 §4.8.9). */
const NON_OPERATION_KEYS = new Set(['summary', 'description', 'servers', 'parameters', '$ref']);

/**
 * Parsed once per test file, not once per assertion.
 *
 * The document is 90 KB of YAML and this suite reads it about fourteen times; each parse is tens of
 * milliseconds alone and far more when the whole workspace runs in parallel. That was not a
 * performance nicety — two runs of `turbo run test` failed here with a five-second timeout on tests
 * whose only work is reading the document, and each time on a *different* one, which reads as
 * flakiness rather than as the cost it is.
 *
 * Safe because the file does not change while a run is in progress: vitest gives each test file its
 * own module registry, so the cache lives exactly as long as one file's tests do.
 */
let parsed: OpenApiDocument | undefined;

export const readOpenApiDocument = (): OpenApiDocument => {
  parsed ??= parseYaml(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDocument;

  return parsed;
};

/**
 * The path prefix the document publishes, taken from the first `servers` entry.
 *
 * Operation paths in the document are written relative to it (`/meta`), while Express knows the
 * full path (`/api/v1/meta`). Recomputing the prefix from the document rather than hard-coding
 * `/api/v1` here means that moving the API to `/api/v2` is one edit in the contract, not two.
 */
export const serverBasePath = (document: OpenApiDocument): string => {
  const url = document.servers?.[0]?.url ?? '';
  const path = url.startsWith('http') ? new URL(url).pathname : url;

  return path === '/' ? '' : path.replace(/\/$/, '');
};

/**
 * Every `path × method` the document declares, spelled the way Express spells it.
 *
 * A path item may itself be a `$ref` to a reusable one; `parseYaml` does not resolve references, so
 * such an entry would arrive here as `{ $ref: … }` with no methods and would silently contribute
 * nothing. It is therefore rejected loudly instead — an operation that vanishes from the
 * comparison is worse than one the tooling refuses to read.
 */
export const specOperationEntries = (document: OpenApiDocument): SpecOperation[] => {
  const base = serverBasePath(document);

  return Object.entries(document.paths ?? {})
    .flatMap(([path, item]): SpecOperation[] => {
      if (item === undefined) return [];

      if ('$ref' in item) {
        throw new Error(
          `docs/api/openapi.yaml: path item "${path}" is a $ref, which this contract test does not resolve. Inline it or teach openapi-document.util.ts to follow it.`,
        );
      }

      return Object.entries(item)
        .filter(([key]) => !NON_OPERATION_KEYS.has(key))
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          documentPath: path,
          routeKey: `${method.toUpperCase()} ${normalizePath(`${base}${path}`)}`,
          operation: (operation ?? {}) as OperationObject,
        }));
    })
    .sort((left, right) => left.routeKey.localeCompare(right.routeKey));
};

export const specOperations = (document: OpenApiDocument): CollectedRoute[] =>
  specOperationEntries(document)
    .map((entry) => ({
      method: entry.method,
      path: normalizePath(`${serverBasePath(document)}${entry.documentPath}`),
    }))
    .sort((left, right) =>
      `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
    );

/**
 * The marker each authorization form is written with in the document, keyed by the name the route
 * registry uses for the same form.
 *
 * One table, read by `route-authorization.test.ts` (which judges the document on its own) and by
 * `openapi.test.ts` (which compares the document with the registry). Two lists of three strings
 * would agree until somebody added a fourth form to one of them.
 */
export const AUTHORIZATION_MARKER: Readonly<Record<AuthorizationForm, string>> = Object.freeze({
  permission: 'x-permission',
  public: 'x-public-reason',
  'self-service': 'x-self-service-reason',
});

/**
 * Which of the three an operation declares, or `undefined` when it declares none — or more than
 * one, which is not "ambiguous but readable": two markers mean two people decided differently and
 * neither answer may be picked here. `route-authorization.test.ts` reports both cases by name.
 */
export const specAuthorizationForm = (
  operation: OperationObject,
): AuthorizationForm | undefined => {
  const declared = AUTHORIZATION_FORMS.filter(
    (form) => operation[AUTHORIZATION_MARKER[form]] !== undefined,
  );

  return declared.length === 1 ? declared[0] : undefined;
};

/**
 * The marker an operation carries while it is published but not yet served.
 *
 * Contract-first means the specification is merged before the code exists (ADR-0003), which puts
 * the second direction of the contract test — "every published operation has a route" — briefly in
 * conflict with the way this project is meant to work. Rather than weaken that assertion for
 * everything, an operation states the story that implements it, and only those are exempt.
 *
 * The exemption is expensive to abuse and cheap to remove:
 * `packages/server/test/contract/planned-operations.test.ts` refuses a marker naming a story file
 * that does not exist, and refuses a marker on an operation the router already answers — so the
 * commit that implements a route has to delete the marker in the same diff.
 */
export const PLANNED_MARKER = 'x-implemented-by';

export const plannedStory = (operation: OperationObject): string | undefined => {
  const value = operation[PLANNED_MARKER];

  return typeof value === 'string' ? value : undefined;
};

/** Route keys of operations that are published but not expected to be served yet. */
export const plannedRouteKeys = (document: OpenApiDocument): Set<string> =>
  new Set(
    specOperationEntries(document)
      .filter((entry) => plannedStory(entry.operation) !== undefined)
      .map((entry) => entry.routeKey),
  );

/** The `enum` values of a named schema, e.g. `ErrorCode`. */
export const schemaEnum = (document: OpenApiDocument, schema: string): string[] => {
  const values = document.components?.schemas?.[schema]?.enum;

  if (!Array.isArray(values)) {
    throw new Error(`docs/api/openapi.yaml: components.schemas.${schema} declares no enum`);
  }

  return values.map(String);
};
