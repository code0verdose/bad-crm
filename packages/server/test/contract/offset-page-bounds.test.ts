import { MAX_PAGE, MAX_PAGE_SIZE } from '@bad-crm/shared/validation';
import { describe, expect, it } from 'vitest';

import { readOpenApiDocument, specOperationEntries } from './openapi-document.util.js';

/**
 * The bound on `page` is a contract, not a validator detail: an offset list answers `422` past
 * `MAX_PAGE` — the last page whose offset at the largest page size fits a 32-bit signed integer —
 * and a client generated from the document has to know that. `/projects` got the bound first and
 * the directory did not; this suite reads **every** `page` and `perPage` query parameter of the
 * document, inline or by reference, so the next offset list cannot ship without it.
 *
 * `MAX_PAGE` comes from `packages/shared`, the same constant the validators use, so the number is
 * written in the document and in one place in code — never a third time here.
 */

interface ParameterObject {
  readonly name?: string;
  readonly in?: string;
  readonly $ref?: string;
  readonly schema?: { readonly maximum?: number };
}

const document = readOpenApiDocument() as ReturnType<typeof readOpenApiDocument> & {
  readonly components?: { readonly parameters?: Record<string, ParameterObject> };
};

const COMPONENT_PREFIX = '#/components/parameters/';

const resolve = (parameter: ParameterObject): ParameterObject => {
  if (parameter.$ref === undefined) return parameter;

  const target = document.components?.parameters?.[parameter.$ref.slice(COMPONENT_PREFIX.length)];

  if (!parameter.$ref.startsWith(COMPONENT_PREFIX) || target === undefined) {
    throw new Error(`docs/api/openapi.yaml: unresolvable parameter ${parameter.$ref}`);
  }

  return target;
};

/** `routeKey → parameter` for one query parameter name, over every operation and every component. */
const queryParameters = (name: string): [string, ParameterObject][] => [
  ...specOperationEntries(document).flatMap(({ routeKey, operation }) =>
    ((operation['parameters'] ?? []) as ParameterObject[])
      .map(resolve)
      .filter((parameter) => parameter.in === 'query' && parameter.name === name)
      .map((parameter): [string, ParameterObject] => [routeKey, parameter]),
  ),
  ...Object.entries(document.components?.parameters ?? {})
    .filter(([, parameter]) => parameter.in === 'query' && parameter.name === name)
    .map(([key, parameter]): [string, ParameterObject] => [`${COMPONENT_PREFIX}${key}`, parameter]),
];

describe('offset pagination bounds in the contract', () => {
  it('CONTROL: finds the page parameters of both offset lists and of the shared component', () => {
    expect(queryParameters('page').map(([where]) => where)).toEqual(
      expect.arrayContaining([
        'GET /api/v1/projects',
        'GET /api/v1/employees',
        `${COMPONENT_PREFIX}Page`,
      ]),
    );
  });

  it('bounds every page at MAX_PAGE', () => {
    expect(
      queryParameters('page').map(([where, parameter]) => [where, parameter.schema?.maximum]),
    ).toEqual(queryParameters('page').map(([where]) => [where, MAX_PAGE]));
  });

  it('caps every perPage at or below MAX_PAGE_SIZE, which is what MAX_PAGE is computed from', () => {
    const perPage = queryParameters('perPage');

    expect(perPage.length).toBeGreaterThan(0);
    for (const [where, parameter] of perPage) {
      expect(parameter.schema?.maximum, where).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    }
  });
});
