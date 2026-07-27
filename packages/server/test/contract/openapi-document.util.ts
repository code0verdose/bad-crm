import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The workspace-root `yaml` devDependency, the same one the repository-level suites use. It is
// deliberately not declared by `packages/server`: nothing under `src/**` parses YAML, and adding a
// runtime dependency to the server so that one test can read a document would be the wrong trade.
import { parse as parseYaml } from 'yaml';

import { normalizePath, type CollectedRoute } from './collect-routes.util.js';

/** The contract itself, as a path this suite can also print in a failure message. */
export const OPENAPI_PATH = fileURLToPath(
  new URL('../../../../docs/api/openapi.yaml', import.meta.url),
);

interface OpenApiDocument {
  servers?: { url?: string }[];
  paths?: Record<string, Record<string, unknown> | undefined>;
  components?: {
    schemas?: Record<string, { enum?: unknown[] } | undefined>;
  };
}

/** Keys of a path item that are not operations (OpenAPI 3.1 §4.8.9). */
const NON_OPERATION_KEYS = new Set(['summary', 'description', 'servers', 'parameters', '$ref']);

export const readOpenApiDocument = (): OpenApiDocument =>
  parseYaml(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDocument;

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
export const specOperations = (document: OpenApiDocument): CollectedRoute[] => {
  const base = serverBasePath(document);

  return Object.entries(document.paths ?? {})
    .flatMap(([path, item]) => {
      if (item === undefined) return [];

      if ('$ref' in item) {
        throw new Error(
          `docs/api/openapi.yaml: path item "${path}" is a $ref, which this contract test does not resolve. Inline it or teach openapi-document.util.ts to follow it.`,
        );
      }

      return Object.keys(item)
        .filter((key) => !NON_OPERATION_KEYS.has(key))
        .map((method) => ({
          method: method.toUpperCase(),
          path: normalizePath(`${base}${path}`),
        }));
    })
    .sort((left, right) =>
      `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
    );
};

/** The `enum` values of a named schema, e.g. `ErrorCode`. */
export const schemaEnum = (document: OpenApiDocument, schema: string): string[] => {
  const values = document.components?.schemas?.[schema]?.enum;

  if (!Array.isArray(values)) {
    throw new Error(`docs/api/openapi.yaml: components.schemas.${schema} declares no enum`);
  }

  return values.map(String);
};
